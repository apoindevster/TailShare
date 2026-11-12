package main

// SFTP over an already authenticated Tailcat connection. Downloads use listed
// IDs; uploads use a validated selection. No shell or local SSH key is used.
import (
	"encoding/binary"
	"errors"
	"io"
	"io/fs"
	"net"
	"path"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

const cliChunk = 32 << 10

// Eight 32 KiB SFTP requests per bounded browser/worker batch.
const cliWindow = 8
const cliBatch = cliChunk * cliWindow
const cliUploadEntryLimit = 10000
const cliMetadataLimit = 4 << 20

type cliEntry struct {
	ID       string `json:"id"`
	Path     string `json:"path"`
	Kind     string `json:"kind"`
	Size     int64  `json:"size"`
	Modified int64  `json:"modified"`
	remote   string
}

// Bound every SFTP packet before allocating it. File operations never enumerate
// directories; the separate paged directory channel applies its own limits.
type cliPacketReader struct {
	r       io.Reader
	pending []byte
}

func (r *cliPacketReader) Read(out []byte) (int, error) {
	if len(r.pending) == 0 {
		var header [4]byte
		if _, err := io.ReadFull(r.r, header[:]); err != nil {
			return 0, err
		}
		n := binary.BigEndian.Uint32(header[:])
		if n == 0 || n > cliPacketLimit {
			return 0, errors.New("SFTP packet exceeds the browser limit")
		}
		r.pending = make([]byte, 4+int(n))
		copy(r.pending, header[:])
		if _, err := io.ReadFull(r.r, r.pending[4:]); err != nil {
			return 0, err
		}
	}
	n := copy(out, r.pending)
	r.pending = r.pending[n:]
	return n, nil
}

type cliShare struct {
	conn      net.Conn
	ssh       *ssh.Client
	sftp      *sftp.Client
	packets   *cliPacketReader
	directory *cliDirectoryClient
	secret    [32]byte
	cursors   map[string]*cliCursor
	file      *sftp.File
	current   cliEntry
	read      int64
	eof       bool
	op        sync.Mutex
	upload    *cliUpload
}

func openCLI(conn net.Conn) (_ *cliShare, err error) {
	conn.SetDeadline(time.Now().Add(30 * time.Second))
	share := &cliShare{conn: conn}
	defer func() {
		if err != nil {
			share.close()
		}
	}()
	// This socket can only be obtained from Tailcat.DialTCPPort(22). WireGuard
	// authenticates the server's node key from the private invitation, just as
	// upstream tailcat ls does; we do not trust arbitrary TCP SSH endpoints.
	sc, chans, reqs, err := ssh.NewClientConn(conn, "tailcat", &ssh.ClientConfig{
		User: "tailshare", HostKeyCallback: ssh.InsecureIgnoreHostKey(),
	})
	if err != nil {
		return nil, errors.New("CLI file service unavailable. Use tailcat serve files to offer files or tailcat recv to receive them; SSH login keys are not supported")
	}
	share.ssh = ssh.NewClient(sc, chans, reqs)
	session, err := share.ssh.NewSession()
	if err != nil {
		return nil, errors.New("Could not open the CLI file service")
	}
	reader, err := session.StdoutPipe()
	if err != nil {
		return nil, err
	}
	writer, err := session.StdinPipe()
	if err != nil {
		return nil, err
	}
	if err = session.RequestSubsystem("sftp"); err != nil {
		return nil, errors.New("This CLI key does not expose an SFTP file share")
	}
	share.packets = &cliPacketReader{r: reader}
	share.sftp, err = sftp.NewClientPipe(share.packets, writer,
		sftp.MaxPacketChecked(cliChunk), sftp.MaxConcurrentRequestsPerFile(cliWindow),
		sftp.UseConcurrentReads(true), sftp.UseConcurrentWrites(true))
	if err != nil {
		return nil, errors.New("Could not start the CLI file service")
	}
	return share, nil
}

func (s *cliShare) close() {
	// Close the underlying connection first: this releases pending SFTP calls
	// and makes cancellation independent of a cooperative remote server.
	s.conn.Close()
	if s.ssh != nil {
		s.ssh.Close()
	}
	if s.sftp != nil {
		s.sftp.Close()
	}
}

func cliChild(parent, name string) (string, error) {
	if !utf8.ValidString(name) || name == "" || name == "." || name == ".." ||
		strings.ContainsAny(name, "/\\\x00") || len(name) > 1024 {
		return "", errors.New("Unsafe CLI file name. Rename it and reconnect")
	}
	joined := path.Join(parent, name)
	if len(joined) > 4096 || strings.Count(joined, "/") >= 32 {
		return "", errors.New("CLI folder nesting exceeds the browser limit")
	}
	return joined, nil
}

func (s *cliShare) checkParents(remote string) error {
	parent := path.Dir(remote)
	for parent != "." {
		info, err := s.sftp.Lstat(parent)
		if err != nil || !info.IsDir() {
			return errors.New("CLI folder changed or is a symbolic link. Reconnect")
		}
		parent = path.Dir(parent)
	}
	return nil
}

func cliUnchanged(info fs.FileInfo, entry cliEntry) bool {
	return info.Mode().IsRegular() && info.Size() == entry.Size && max(0, info.ModTime().UnixMilli()) == entry.Modified
}

func (s *cliShare) openFile(id string) error {
	s.op.Lock()
	defer s.op.Unlock()
	s.conn.SetDeadline(time.Now().Add(120 * time.Second))
	entry, tokenErr := s.verifyEntry(id)
	if tokenErr != nil || entry.Kind != "file" || s.file != nil {
		return errors.New("File is not available in this CLI share")
	}
	if err := s.checkParents(entry.remote); err != nil {
		return err
	}
	info, err := s.sftp.Lstat(entry.remote)
	if err != nil || !cliUnchanged(info, entry) {
		return errors.New("CLI file changed or is a symbolic link. Reconnect")
	}
	f, err := s.sftp.Open(entry.remote) // SSH_FXF_READ only
	if err != nil {
		return errors.New("CLI file cannot be read. Reconnect and try again")
	}
	info, err = f.Stat()
	if err != nil || !cliUnchanged(info, entry) {
		f.Close()
		return errors.New("CLI file changed. Reconnect")
	}
	s.file, s.current, s.read, s.eof = f, entry, 0, false
	return nil
}

func (s *cliShare) readFile() ([]byte, error) {
	s.op.Lock()
	defer s.op.Unlock()
	if s.file == nil || s.eof {
		return nil, errors.New("No CLI download is active")
	}
	s.conn.SetDeadline(time.Now().Add(120 * time.Second))
	buf := make([]byte, min(cliBatch, s.current.Size-s.read+1))
	n, err := s.file.Read(buf)
	s.read += int64(n)
	if s.read > s.current.Size {
		return nil, errors.New("CLI file grew during transfer. Download discarded")
	}
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, errors.New("CLI download interrupted. Reconnect and try again")
	}
	if n > 0 {
		return buf[:n], nil
	}
	if err == nil || s.read != s.current.Size {
		return nil, errors.New("CLI file length changed. Download discarded")
	}
	s.eof = true
	return nil, nil
}

func (s *cliShare) finishFile() error {
	s.op.Lock()
	defer s.op.Unlock()
	s.conn.SetDeadline(time.Now().Add(120 * time.Second))
	if s.file == nil || !s.eof {
		return errors.New("CLI file is incomplete")
	}
	info, err := s.file.Stat()
	if err != nil || !cliUnchanged(info, s.current) {
		return errors.New("CLI file changed during transfer. Download discarded")
	}
	if err := s.checkParents(s.current.remote); err != nil {
		return err
	}
	info, err = s.sftp.Lstat(s.current.remote)
	if err != nil || !cliUnchanged(info, s.current) {
		return errors.New("CLI file changed during transfer. Download discarded")
	}
	err = s.file.Close()
	s.file = nil
	s.conn.SetDeadline(time.Now().Add(15 * time.Minute))
	if err != nil {
		return errors.New("CLI file could not be completed. Download discarded")
	}
	return nil
}

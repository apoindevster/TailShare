package main

// Minimal read-only SFTP v3 directory channel. pkg/sftp's ReadDir collects a
// complete directory, so listing uses bounded wire packets and explicit cursors.
// File reads/writes and metadata checks continue to use pkg/sftp.
import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"path"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/text/unicode/norm"
)

const cliPacketLimit = 256 << 10
const cliPageLimit = 128
const cliPageBytes = 1 << 20
const cliTokenLimit = 8192
const cliCursorLimit = 34 // browse cursor plus a depth-first walk, at most 32 levels

type cliPage struct {
	Entries []cliEntry `json:"entries"`
	Skipped int        `json:"skipped"`
	Cursor  string     `json:"cursor"`
	Done    bool       `json:"done"`
}
type cliCursor struct {
	directory string
	handle    string
	remaining uint32
	data      []byte
}
type cliDirectoryClient struct {
	r       io.Reader
	w       io.Writer
	session *ssh.Session
	next    uint32
}

// Listed entries carry a session-authenticated capability. This avoids retaining
// one Go map entry for every file ever visited, without accepting arbitrary paths.
type cliCapability struct {
	Path     string
	Kind     string
	Size     int64
	Modified int64
}

func (s *cliShare) signEntry(e cliEntry) string {
	payload, _ := json.Marshal(cliCapability{e.remote, e.Kind, e.Size, e.Modified})
	mac := hmac.New(sha256.New, s.secret[:])
	mac.Write(payload)
	return base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
func (s *cliShare) verifyEntry(id string) (cliEntry, error) {
	invalid := errors.New("File or folder is not available in this CLI session. Refresh the folder")
	if s.directory == nil || len(id) > cliTokenLimit {
		return cliEntry{}, invalid
	}
	parts := strings.Split(id, ".")
	if len(parts) != 2 {
		return cliEntry{}, invalid
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return cliEntry{}, invalid
	}
	tag, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return cliEntry{}, invalid
	}
	mac := hmac.New(sha256.New, s.secret[:])
	mac.Write(payload)
	if !hmac.Equal(mac.Sum(nil), tag) {
		return cliEntry{}, invalid
	}
	var c cliCapability
	if json.Unmarshal(payload, &c) != nil {
		return cliEntry{}, invalid
	}
	return cliEntry{ID: id, Path: norm.NFC.String(c.Path), Kind: c.Kind, Size: c.Size, Modified: c.Modified, remote: c.Path}, nil
}

func (s *cliShare) startDirectories() error {
	if s.directory != nil {
		return nil
	}
	if _, err := rand.Read(s.secret[:]); err != nil {
		return err
	}
	session, err := s.ssh.NewSession()
	if err != nil {
		return errors.New("Could not open the CLI directory service")
	}
	r, err := session.StdoutPipe()
	if err != nil {
		session.Close()
		return err
	}
	w, err := session.StdinPipe()
	if err != nil {
		session.Close()
		return err
	}
	if err := session.RequestSubsystem("sftp"); err != nil {
		session.Close()
		return errors.New("CLI directory service unavailable")
	}
	d := &cliDirectoryClient{r: r, w: w, session: session}
	if err := d.write(1, u32(nil, 3)); err != nil {
		session.Close()
		return err
	}
	response, err := d.read()
	if err != nil {
		session.Close()
		return err
	}
	if len(response) < 5 || response[0] != 2 || binary.BigEndian.Uint32(response[1:5]) != 3 {
		session.Close()
		return errors.New("Unsupported CLI directory protocol")
	}
	s.directory = d
	s.cursors = make(map[string]*cliCursor)
	return nil
}

func u32(b []byte, n uint32) []byte            { return binary.BigEndian.AppendUint32(b, n) }
func sftpString(b []byte, value string) []byte { return append(u32(b, uint32(len(value))), value...) }

type cliDecoder struct {
	data []byte
	err  error
}

func (d *cliDecoder) take(n int) []byte {
	if d.err != nil || n < 0 || n > len(d.data) {
		d.err = errors.New("Invalid SFTP directory packet")
		return nil
	}
	b := d.data[:n]
	d.data = d.data[n:]
	return b
}
func (d *cliDecoder) uint32() uint32 {
	b := d.take(4)
	if len(b) != 4 {
		return 0
	}
	return binary.BigEndian.Uint32(b)
}
func (d *cliDecoder) uint64() uint64 {
	b := d.take(8)
	if len(b) != 8 {
		return 0
	}
	return binary.BigEndian.Uint64(b)
}
func (d *cliDecoder) str() string {
	n := d.uint32()
	if uint64(n) > uint64(len(d.data)) {
		d.err = errors.New("Invalid SFTP string")
		return ""
	}
	return string(d.take(int(n)))
}

func (d *cliDirectoryClient) write(kind byte, body []byte) error {
	packet := append(u32(nil, uint32(len(body)+1)), kind)
	packet = append(packet, body...)
	for len(packet) > 0 {
		n, err := d.w.Write(packet)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		packet = packet[n:]
	}
	return nil
}
func (d *cliDirectoryClient) read() ([]byte, error) {
	var header [4]byte
	if _, err := io.ReadFull(d.r, header[:]); err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint32(header[:])
	if n == 0 || n > cliPacketLimit {
		return nil, errors.New("SFTP packet exceeds the browser limit")
	}
	packet := make([]byte, int(n))
	_, err := io.ReadFull(d.r, packet)
	return packet, err
}
func (d *cliDirectoryClient) request(kind byte, value string) (byte, []byte, error) {
	d.next++
	id := d.next
	if err := d.write(kind, sftpString(u32(nil, id), value)); err != nil {
		return 0, nil, err
	}
	packet, err := d.read()
	if err != nil {
		return 0, nil, err
	}
	if len(packet) < 5 || binary.BigEndian.Uint32(packet[1:5]) != id {
		return 0, nil, errors.New("Invalid SFTP directory response")
	}
	return packet[0], packet[5:], nil
}

type cliFolderError struct{ message string }

func (e *cliFolderError) Error() string { return e.message }

func directoryStatus(data []byte) error {
	d := cliDecoder{data: data}
	code := d.uint32()
	d.str()
	d.str()
	if d.err != nil || len(d.data) != 0 {
		return errors.New("Invalid SFTP directory status")
	}
	switch code {
	case 0:
		return nil
	case 1:
		return io.EOF
	case 2:
		return &cliFolderError{"CLI folder no longer exists. Refresh its parent folder"}
	case 3:
		return &cliFolderError{"CLI folder is not readable. Check its permissions"}
	}
	return &cliFolderError{"CLI folder could not be read. Refresh the folder or reconnect"}
}
func (s *cliShare) closeCursor(id string) error {
	c := s.cursors[id]
	if c == nil {
		return nil
	}
	delete(s.cursors, id)
	kind, data, err := s.directory.request(4, c.handle)
	if err != nil {
		return err
	}
	if kind != 101 {
		return errors.New("Invalid SFTP close response")
	}
	return directoryStatus(data)
}

func (s *cliShare) directoryPage(parent context.Context, op, value string) (result cliPage, err error) {
	s.op.Lock()
	defer s.op.Unlock()
	result.Entries = []cliEntry{}
	ctx, cancel := context.WithTimeout(parent, 60*time.Second)
	defer cancel()
	stop := context.AfterFunc(ctx, func() { s.conn.Close() })
	defer stop()
	s.conn.SetDeadline(time.Now().Add(60 * time.Second))
	defer func() {
		if ctx.Err() == context.DeadlineExceeded {
			err = errors.New("Reading this CLI folder timed out. Reconnect and try again")
		} else if ctx.Err() != nil {
			err = errors.New("CLI connection cancelled")
		}
		if err == nil {
			s.conn.SetDeadline(time.Now().Add(15 * time.Minute))
		}
	}()
	if s.upload != nil {
		return result, errors.New("Cannot browse a CLI upload session")
	}
	if err = s.startDirectories(); err != nil {
		return result, err
	}
	if op == "close" {
		result.Done = true
		err = s.closeCursor(value)
		return
	}
	id := value
	if op == "open" {
		if len(s.cursors) >= cliCursorLimit {
			return result, errors.New("Too many open CLI folders")
		}
		dir := "."
		if value != "" {
			e, eerr := s.verifyEntry(value)
			if eerr != nil {
				return result, eerr
			}
			if e.Kind != "directory" {
				return result, errors.New("Choose a listed folder")
			}
			dir = e.remote
		}
		if err = s.checkParents(path.Join(dir, "placeholder")); err != nil {
			return result, &cliFolderError{err.Error()}
		}
		kind, data, e := s.directory.request(11, dir)
		if e != nil {
			return result, e
		}
		if kind == 101 {
			status := directoryStatus(data)
			if status == nil || status == io.EOF {
				status = errors.New("Invalid SFTP open-directory status")
			}
			return result, status
		}
		if kind != 102 {
			return result, errors.New("Invalid SFTP directory handle")
		}
		decoded := cliDecoder{data: data}
		handle := decoded.str()
		if decoded.err != nil || len(decoded.data) != 0 || len(handle) == 0 || len(handle) > 4096 {
			return result, errors.New("Invalid SFTP directory handle")
		}
		var random [16]byte
		if _, err = rand.Read(random[:]); err != nil {
			return result, err
		}
		id = hex.EncodeToString(random[:])
		s.cursors[id] = &cliCursor{directory: dir, handle: handle}
	} else if op != "next" {
		return result, errors.New("Unsupported CLI directory operation")
	}
	c := s.cursors[id]
	if c == nil {
		return result, errors.New("CLI folder cursor expired. Refresh the folder")
	}
	// A cursor is single-use. Replaying an old request cannot silently skip a page.
	delete(s.cursors, id)
	defer func() {
		if err != nil {
			var folderError *cliFolderError
			if errors.As(err, &folderError) {
				_, _, _ = s.directory.request(4, c.handle)
			} else {
				s.conn.Close()
			}
		}
	}()
	if err = s.checkParents(path.Join(c.directory, "placeholder")); err != nil {
		return result, &cliFolderError{err.Error()}
	}
	if c.remaining == 0 {
		kind, data, e := s.directory.request(12, c.handle)
		if e != nil {
			return result, e
		}
		if kind == 101 {
			status := directoryStatus(data)
			if status == io.EOF {
				kind, data, e = s.directory.request(4, c.handle)
				if e != nil {
					return result, e
				}
				if kind != 101 {
					return result, errors.New("Invalid SFTP close response")
				}
				if err = directoryStatus(data); err != nil {
					return result, err
				}
				result.Done = true
				return result, nil
			}
			if status == nil {
				status = errors.New("Invalid SFTP directory status")
			}
			return result, status
		}
		if kind != 104 {
			return result, errors.New("Invalid SFTP directory listing")
		}
		decoded := cliDecoder{data: data}
		c.remaining = decoded.uint32()
		c.data = decoded.data
		if decoded.err != nil || c.remaining == 0 || c.remaining > uint32(len(c.data)/12) {
			return result, errors.New("Invalid SFTP directory count")
		}
	}
	bytes := 0
	for scanned := 0; scanned < cliPageLimit && c.remaining > 0; scanned++ {
		d := cliDecoder{data: c.data}
		name := d.str()
		d.str()
		flags := d.uint32()
		if flags & ^uint32(0x8000000f) != 0 {
			return result, errors.New("Unsupported SFTP file attributes")
		}
		var size uint64
		var mode, modified uint32
		if flags&1 != 0 {
			size = d.uint64()
		}
		if flags&2 != 0 {
			d.take(8)
		}
		if flags&4 != 0 {
			mode = d.uint32()
		}
		if flags&8 != 0 {
			d.uint32()
			modified = d.uint32()
		}
		if flags&0x80000000 != 0 {
			count := d.uint32()
			if uint64(count) > uint64(len(d.data)/8) {
				return result, errors.New("Invalid SFTP attributes")
			}
			for i := uint32(0); i < count; i++ {
				d.str()
				d.str()
			}
		}
		if d.err != nil {
			return result, d.err
		}
		c.data = d.data
		c.remaining--
		if name == "." || name == ".." {
			continue
		}
		remote, e := cliChild(c.directory, name)
		if e != nil {
			return result, e
		}
		fileType := mode & 0170000
		if flags&4 == 0 || fileType != 0040000 && fileType != 0100000 {
			result.Skipped++
			continue
		}
		if size > 1<<53-1 {
			return result, errors.New("CLI file size exceeds the browser limit")
		}
		entry := cliEntry{Path: norm.NFC.String(remote), Kind: "file", Size: int64(size), Modified: int64(modified) * 1000, remote: remote}
		if fileType == 0040000 {
			entry.Kind = "directory"
			entry.Size = 0
		}
		entry.ID = s.signEntry(entry)
		encoded, _ := json.Marshal(entry)
		bytes += len(encoded) + 1
		if len(entry.ID) > cliTokenLimit || bytes > cliPageBytes-256 {
			return result, errors.New("CLI directory page exceeds the metadata limit")
		}
		result.Entries = append(result.Entries, entry)
	}
	if c.remaining == 0 && len(c.data) != 0 {
		return result, errors.New("Trailing data in SFTP directory packet")
	}
	var random [16]byte
	if _, err = rand.Read(random[:]); err != nil {
		return result, err
	}
	result.Cursor = hex.EncodeToString(random[:])
	s.cursors[result.Cursor] = c
	return result, nil
}

package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

func testCLI(t *testing.T, root string, writable ...bool) *cliShare {
	t.Helper()
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(private)
	if err != nil {
		t.Fatal(err)
	}
	config := &ssh.ServerConfig{NoClientAuth: true}
	config.AddHostKey(signer)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		server, channels, requests, err := ssh.NewServerConn(conn, config)
		if err != nil {
			return
		}
		defer server.Close()
		go ssh.DiscardRequests(requests)
		for request := range channels {
			if request.ChannelType() != "session" {
				request.Reject(ssh.UnknownChannelType, "session only")
				continue
			}
			channel, requests, err := request.Accept()
			if err != nil {
				return
			}
			go func() {
				defer channel.Close()
				for r := range requests {
					if r.Type != "subsystem" || string(r.Payload) != "\x00\x00\x00\x04sftp" {
						r.Reply(false, nil)
						continue
					}
					r.Reply(true, nil)
					opts := []sftp.ServerOption{sftp.WithServerWorkingDirectory(root)}
					if len(writable) == 0 || !writable[0] {
						opts = append(opts, sftp.ReadOnly())
					}
					srv, err := sftp.NewServer(channel, opts...)
					if err == nil {
						srv.Serve()
						srv.Close()
					}
					return
				}
			}()
		}
	}()
	conn, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	share, err := openCLI(conn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(share.close)
	return share
}

func putCLI(t *testing.T, root, name string, data []byte) {
	t.Helper()
	p := filepath.Join(root, name)
	if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, data, 0600); err != nil {
		t.Fatal(err)
	}
}

func cliFixture(t *testing.T) (*cliShare, string, cliEntry) {
	t.Helper()
	root := t.TempDir()
	putCLI(t, root, "folder/file.txt", []byte("synthetic CLI file"))
	s := testCLI(t, root)
	catalog, err := s.catalog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range catalog.Entries {
		if e.Kind == "file" {
			return s, root, e
		}
	}
	t.Fatal("file missing from catalog")
	return nil, "", cliEntry{}
}

func TestCLIBrowseAndRead(t *testing.T) {
	root := t.TempDir()
	want := bytes.Repeat([]byte{0, 255, 42}, 80000)
	putCLI(t, root, "folder/binary.bin", want)
	putCLI(t, root, "empty.txt", nil)
	if err := os.Mkdir(filepath.Join(root, "empty-folder"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(t.TempDir(), filepath.Join(root, "outside")); err != nil {
		t.Fatal(err)
	}
	s := testCLI(t, root)
	catalog, err := s.catalog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog.Entries) != 4 || catalog.Skipped != 1 {
		t.Fatalf("unexpected catalog: %d entries, %d skipped", len(catalog.Entries), catalog.Skipped)
	}
	for _, e := range catalog.Entries {
		if e.Kind != "file" {
			continue
		}
		if err := s.openFile(e.ID); err != nil {
			t.Fatal(err)
		}
		var out []byte
		for {
			data, err := s.readFile()
			if err != nil {
				t.Fatal(err)
			}
			if data == nil {
				break
			}
			if len(data) > cliBatch {
				t.Fatal("unbounded read")
			}
			out = append(out, data...)
		}
		if err := s.finishFile(); err != nil {
			t.Fatal(err)
		}
		if e.Path == "folder/binary.bin" && !bytes.Equal(out, want) {
			t.Fatal("incorrect binary download")
		}
		if e.Path == "empty.txt" && len(out) != 0 {
			t.Fatal("incorrect empty download")
		}
	}
}

func TestCLIRejectsUnknownFile(t *testing.T) {
	s, _, _ := cliFixture(t)
	if err := s.openFile("../outside"); err == nil {
		t.Fatal("accepted an unlisted path")
	}
}

func TestCLIRejectsReplacedFileAndDirectory(t *testing.T) {
	for _, directory := range []bool{false, true} {
		t.Run(map[bool]string{false: "file", true: "directory"}[directory], func(t *testing.T) {
			s, root, e := cliFixture(t)
			p := filepath.Join(root, "folder", "file.txt")
			if directory {
				p = filepath.Dir(p)
			}
			if err := os.RemoveAll(p); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(t.TempDir(), p); err != nil {
				t.Fatal(err)
			}
			if err := s.openFile(e.ID); err == nil {
				t.Fatal("followed a replacement symlink")
			}
		})
	}
}

func TestCLIRejectsChangedAndTruncatedFiles(t *testing.T) {
	for _, during := range []bool{false, true} {
		t.Run(map[bool]string{false: "before", true: "during"}[during], func(t *testing.T) {
			s, root, e := cliFixture(t)
			if during {
				if err := s.openFile(e.ID); err != nil {
					t.Fatal(err)
				}
			}
			putCLI(t, root, "folder/file.txt", []byte("x"))
			if !during {
				if err := s.openFile(e.ID); err == nil {
					t.Fatal("accepted changed file")
				}
				return
			}
			for i := 0; i < 3; i++ {
				if _, err := s.readFile(); err != nil {
					return
				}
			}
			t.Fatal("accepted truncated file")
		})
	}
}

func TestCLIRejectsChangesBeforeCommit(t *testing.T) {
	s, root, e := cliFixture(t)
	if err := s.openFile(e.ID); err != nil {
		t.Fatal(err)
	}
	for {
		data, err := s.readFile()
		if err != nil {
			t.Fatal(err)
		}
		if data == nil {
			break
		}
	}
	changed := time.Now().Add(time.Minute)
	if err := os.Chtimes(filepath.Join(root, "folder/file.txt"), changed, changed); err != nil {
		t.Fatal(err)
	}
	if err := s.finishFile(); err == nil {
		t.Fatal("committed changed file")
	}
}

func TestCLICloseInterruptsRead(t *testing.T) {
	s, _, e := cliFixture(t)
	if err := s.openFile(e.ID); err != nil {
		t.Fatal(err)
	}
	s.close()
	if _, err := s.readFile(); err == nil {
		t.Fatal("read after disconnect")
	}
}

func TestCLIPacketLimits(t *testing.T) {
	packet := func(n uint32, data []byte) []byte {
		b := make([]byte, 4)
		binary.BigEndian.PutUint32(b, n)
		return append(b, data...)
	}
	for _, data := range [][]byte{
		packet(0, nil), packet(256<<10+1, nil),
	} {
		r := &cliPacketReader{r: bytes.NewReader(data)}
		if _, err := io.ReadAll(r); err == nil {
			t.Fatal("accepted malformed/oversized packet")
		}
	}

}

func TestCLIPathBounds(t *testing.T) {
	for _, name := range []string{"..", ".", "a/b", "a\\b", "\x00", "/etc", strings.Repeat("a", 1025)} {
		if _, err := cliChild("folder", name); err == nil {
			t.Fatal("accepted unsafe component")
		}
	}
	if _, err := cliChild(strings.Repeat("folder/", 32), "x"); err == nil {
		t.Fatal("accepted excessive depth")
	}
}

// Small fixture helper only. Production never creates a whole-tree catalog.
type cliCatalog struct {
	Entries []cliEntry
	Skipped int
}

func (s *cliShare) catalog(ctx context.Context) (cliCatalog, error) {
	out := cliCatalog{}
	var visit func(string) error
	visit = func(token string) error {
		page, err := s.directoryPage(ctx, "open", token)
		for err == nil {
			out.Skipped += page.Skipped
			for _, e := range page.Entries {
				out.Entries = append(out.Entries, e)
				if e.Kind == "directory" {
					if err := visit(e.ID); err != nil {
						return err
					}
				}
			}
			if page.Done {
				return nil
			}
			page, err = s.directoryPage(ctx, "next", page.Cursor)
		}
		return err
	}
	err := visit("")
	return out, err
}

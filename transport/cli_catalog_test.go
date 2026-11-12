package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCLIPagedDirectoryBeyondTenThousand(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 10050; i++ {
		putCLI(t, root, fmt.Sprintf("file-%05d.txt", i), nil)
	}
	putCLI(t, root, "unopened/deeper/file.txt", []byte("nested"))
	s := testCLI(t, root)
	page, err := s.directoryPage(context.Background(), "open", "")
	if err != nil {
		t.Fatal(err)
	}
	if page.Done || len(page.Entries) > cliPageLimit {
		t.Fatal("root was not paginated")
	}
	count := 0
	var folder cliEntry
	seen := map[string]bool{}
	firstCursor := page.Cursor
	for {
		if len(page.Entries) > cliPageLimit || len(s.cursors) > 1 {
			t.Fatal("unbounded directory state")
		}
		for _, e := range page.Entries {
			if strings.Contains(e.Path, "/") {
				t.Fatal("eagerly traversed an unopened directory")
			}
			if seen[e.Path] {
				t.Fatal("duplicate page entry")
			}
			seen[e.Path] = true
			count++
			if e.Kind == "directory" {
				folder = e
			}
		}
		if page.Done {
			break
		}
		page, err = s.directoryPage(context.Background(), "next", page.Cursor)
		if err != nil {
			t.Fatal(err)
		}
	}
	if count != 10051 {
		t.Fatalf("lost entries: %d", count)
	}
	if len(s.cursors) != 0 {
		t.Fatal("EOF leaked a cursor")
	}
	if _, err = s.directoryPage(context.Background(), "next", firstCursor); err == nil {
		t.Fatal("accepted a replayed cursor")
	}
	page, err = s.directoryPage(context.Background(), "open", folder.ID)
	if err != nil || len(page.Entries) != 1 || page.Entries[0].Path != "unopened/deeper" {
		t.Fatalf("nested navigation failed: %v", err)
	}
	if _, err = s.directoryPage(context.Background(), "close", page.Cursor); err != nil {
		t.Fatal(err)
	}
	if len(s.cursors) != 0 {
		t.Fatal("close leaked a cursor")
	}
}

func TestCLIDirectoryCapabilitiesAndSymlinks(t *testing.T) {
	root := t.TempDir()
	putCLI(t, root, "folder/file.txt", nil)
	s := testCLI(t, root)
	p, err := s.directoryPage(context.Background(), "open", "")
	if err != nil {
		t.Fatal(err)
	}
	folder := p.Entries[0]
	for _, token := range []string{"../outside", folder.ID[:len(folder.ID)-2] + "ZZ"} {
		if _, err := s.directoryPage(context.Background(), "open", token); err == nil {
			t.Fatal("accepted an unissued folder capability")
		}
	}
	other := testCLI(t, root)
	if _, err := other.directoryPage(context.Background(), "open", folder.ID); err == nil {
		t.Fatal("accepted another session's capability")
	}
	if err := os.Rename(filepath.Join(root, "folder"), filepath.Join(root, "original")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(t.TempDir(), filepath.Join(root, "folder")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.directoryPage(context.Background(), "open", folder.ID); err == nil {
		t.Fatal("followed replacement symlink")
	}
}

func rawPageShare(t *testing.T, response []byte) *cliShare {
	t.Helper()
	client, remote := net.Pipe()
	t.Cleanup(func() { client.Close(); remote.Close() })
	return &cliShare{conn: client, directory: &cliDirectoryClient{r: bytes.NewReader(response), w: io.Discard}, cursors: map[string]*cliCursor{"cursor": {directory: ".", handle: "handle"}}}
}
func directoryPacket(body []byte) []byte { return append(u32(nil, uint32(len(body))), body...) }
func TestCLIDirectoryRejectsMalformedPackets(t *testing.T) {
	name := sftpString(sftpString(nil, "file.txt"), "")
	cases := [][]byte{
		directoryPacket(append([]byte{104}, u32(u32(nil, 1), 0xffffffff)...)),
		directoryPacket(append([]byte{104}, u32(u32(nil, 1), 0)...)),
		directoryPacket(append(append([]byte{104}, u32(u32(nil, 1), 1)...), append(name, u32(nil, 16)...)...)),
		directoryPacket(append(append([]byte{104}, u32(u32(nil, 1), 1)...), append(name, u32(nil, 1)...)...)),
		directoryPacket(append([]byte{104}, u32(u32(nil, 99), 1)...)),
		u32(nil, cliPacketLimit+1),
	}
	for i, b := range cases {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			s := rawPageShare(t, b)
			if _, err := s.directoryPage(context.Background(), "next", "cursor"); err == nil {
				t.Fatal("accepted malformed packet")
			}
		})
	}
}
func TestCLIDirectoryCancellation(t *testing.T) {
	for _, timeout := range []bool{false, true} {
		t.Run(fmt.Sprint(timeout), func(t *testing.T) {
			client, server := net.Pipe()
			defer client.Close()
			defer server.Close()
			s := &cliShare{conn: client, directory: &cliDirectoryClient{r: client, w: client}, cursors: map[string]*cliCursor{"cursor": {directory: ".", handle: "handle"}}}
			started := make(chan struct{})
			go func() {
				var header [4]byte
				_, err := io.ReadFull(server, header[:])
				if err == nil {
					_, _ = io.CopyN(io.Discard, server, int64(binary.BigEndian.Uint32(header[:])))
				}
				close(started)
			}()
			ctx := context.Background()
			var cancel context.CancelFunc
			if timeout {
				ctx, cancel = context.WithTimeout(ctx, time.Second)
			} else {
				ctx, cancel = context.WithCancel(ctx)
			}
			defer cancel()
			done := make(chan error, 1)
			go func() { _, err := s.directoryPage(ctx, "next", "cursor"); done <- err }()
			<-started
			if !timeout {
				cancel()
			}
			select {
			case err := <-done:
				if err == nil {
					t.Fatal("cancelled page succeeded")
				}
			case <-time.After(3 * time.Second):
				t.Fatal("listing did not cancel")
			}
		})
	}
}

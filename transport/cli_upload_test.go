package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func uploadPlan(t *testing.T, mode string, entries ...cliEntry) cliUploadPlan {
	t.Helper()
	b, _ := json.Marshal(cliUploadPlan{Mode: mode, Entries: entries})
	p, err := parseUploadPlan(string(b))
	if err != nil {
		t.Fatal(err)
	}
	return p
}
func uploadEntry(id, path string, size int64) cliEntry {
	return cliEntry{ID: id, Path: path, Kind: "file", Size: size}
}

func TestCLIUploadFlatAndZip(t *testing.T) {
	for _, mode := range []string{"flat", "zip"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			s := testCLI(t, root, true)
			name := "file.bin"
			if mode == "zip" {
				name = "TailShare.zip"
			}
			data := bytes.Repeat([]byte{255, 0, 41}, 25000)
			bound := int64(len(data))
			if mode == "zip" {
				bound += 100
			}
			p := uploadPlan(t, mode, uploadEntry("1", name, bound))
			if _, err := s.prepareUpload(context.Background(), p); err != nil {
				t.Fatal(err)
			}
			if err := s.openUpload("1"); err != nil {
				t.Fatal(err)
			}
			for offset := 0; offset < len(data); offset += cliChunk {
				if err := s.writeUpload(data[offset:min(offset+cliChunk, len(data))]); err != nil {
					t.Fatal(err)
				}
			}
			if err := s.finishUpload(); err != nil {
				t.Fatal(err)
			}
			got, err := os.ReadFile(filepath.Join(root, name))
			if err != nil || !bytes.Equal(data, got) {
				t.Fatal("incorrect upload")
			}
			if err := s.openUpload("1"); err == nil {
				t.Fatal("repeated completed upload")
			}
		})
	}
}
func TestCLIUploadTreeAndEmptyFiles(t *testing.T) {
	root := t.TempDir()
	s := testCLI(t, root, true)
	p := uploadPlan(t, "tree", cliEntry{ID: "d", Path: "empty-dir", Kind: "directory"}, uploadEntry("f", "empty-dir/zero.txt", 0))
	folder, err := s.prepareUpload(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(folder, "TailShare-") {
		t.Fatal("missing unique folder")
	}
	if err := s.openUpload("f"); err != nil {
		t.Fatal(err)
	}
	if err := s.finishUpload(); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(root, folder, "empty-dir/zero.txt"))
	if err != nil || info.Size() != 0 {
		t.Fatal("empty file missing")
	}
}
func TestCLIUploadNoOverwriteOrSymlink(t *testing.T) {
	for _, link := range []bool{false, true} {
		t.Run(map[bool]string{false: "existing", true: "symlink"}[link], func(t *testing.T) {
			root := t.TempDir()
			outside := t.TempDir()
			putCLI(t, outside, "original", []byte("unchanged"))
			if link {
				if err := os.Symlink(filepath.Join(outside, "original"), filepath.Join(root, "file")); err != nil {
					t.Fatal(err)
				}
			} else {
				putCLI(t, root, "file", []byte("unchanged"))
			}
			s := testCLI(t, root, true)
			p := uploadPlan(t, "flat", uploadEntry("f", "file", 1))
			if _, err := s.prepareUpload(context.Background(), p); err != nil {
				t.Fatal(err)
			}
			if err := s.openUpload("f"); err == nil {
				t.Fatal("overwrote existing path")
			}
			got, _ := os.ReadFile(filepath.Join(root, "file"))
			if string(got) != "unchanged" {
				t.Fatal("changed existing contents")
			}
		})
	}
}
func TestCLIUploadRejectsInvalidOperations(t *testing.T) {
	s := testCLI(t, t.TempDir(), true)
	p := uploadPlan(t, "flat", uploadEntry("f", "file", 2))
	if _, err := s.prepareUpload(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	if err := s.openUpload("../x"); err == nil {
		t.Fatal("unknown ID accepted")
	}
	if err := s.openUpload("f"); err != nil {
		t.Fatal(err)
	}
	for _, chunk := range [][]byte{nil, make([]byte, cliBatch+1), make([]byte, 3)} {
		if err := s.writeUpload(chunk); err == nil {
			t.Fatal("invalid chunk accepted")
		}
	}
	if err := s.writeUpload([]byte{1}); err != nil {
		t.Fatal(err)
	}
	if err := s.finishUpload(); err == nil {
		t.Fatal("short upload completed")
	}
	s.close()
	if err := s.writeUpload([]byte{2}); err == nil {
		t.Fatal("write after cancellation")
	}
}
func TestCLIUploadPlanValidation(t *testing.T) {
	entries := []cliEntry{uploadEntry("f", "../secret", 0), uploadEntry("f", "/absolute", 0), uploadEntry("f", "folder\\secret", 0), uploadEntry("f", "CON.txt", 0), uploadEntry("f", "f.", 0), uploadEntry("f", "f", -1), uploadEntry("f", "f", 1<<53), uploadEntry("f", "a/f", 0)}
	for _, e := range entries {
		b, _ := json.Marshal(cliUploadPlan{Mode: "flat", Entries: []cliEntry{e}})
		if _, err := parseUploadPlan(string(b)); err == nil {
			t.Fatal("unsafe plan accepted")
		}
	}
	for _, input := range []string{`{}`, `{"mode":"bad","entries":[]}`, strings.Repeat(" ", cliMetadataLimit+1)} {
		if _, err := parseUploadPlan(input); err == nil {
			t.Fatal("invalid plan accepted")
		}
	}
	for _, mode := range []string{"flat", "tree"} {
		b, _ := json.Marshal(cliUploadPlan{Mode: mode, Entries: []cliEntry{uploadEntry("1", "f", 0), uploadEntry("2", "F", 0)}})
		if _, err := parseUploadPlan(string(b)); err == nil {
			t.Fatal("duplicate path accepted")
		}
	}
}

// Vary bytes and packet offsets to detect reordered, skipped or repeated data.
func TestCLIPipelinedTransfer(t *testing.T) {
	root := t.TempDir()
	data := make([]byte, 2*cliBatch+173)
	for i := range data {
		data[i] = byte(i/cliChunk + i%251)
	}
	s := testCLI(t, root, true)
	p := cliUploadPlan{Mode: "flat", Entries: []cliEntry{uploadEntry("one", "ordered.bin", int64(len(data)))}}
	if _, err := s.prepareUpload(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	if err := s.openUpload("one"); err != nil {
		t.Fatal(err)
	}
	for offset := 0; offset < len(data); offset += cliBatch {
		if err := s.writeUpload(data[offset:min(offset+cliBatch, len(data))]); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.finishUpload(); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(root, "ordered.bin"))
	if err != nil || !bytes.Equal(got, data) {
		t.Fatal("pipelined upload changed content", err)
	}
	receiver := testCLI(t, root)
	catalog, err := receiver.catalog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err := receiver.openFile(catalog.Entries[0].ID); err != nil {
		t.Fatal(err)
	}
	var downloaded []byte
	for {
		chunk, err := receiver.readFile()
		if err != nil {
			t.Fatal(err)
		}
		if chunk == nil {
			break
		}
		if len(chunk) > cliBatch {
			t.Fatal("unbounded pipeline")
		}
		downloaded = append(downloaded, chunk...)
	}
	if err := receiver.finishFile(); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(downloaded, data) {
		t.Fatal("pipelined download changed content")
	}
}

package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

type cliUploadPlan struct {
	Mode    string     `json:"mode"`
	Entries []cliEntry `json:"entries"`
}

type cliUpload struct {
	mode    string
	root    string
	entries map[string]cliEntry
	done    map[string]bool
}

var cliID = regexp.MustCompile(`^[a-zA-Z0-9-]{1,64}$`)
var cliDevice = regexp.MustCompile(`(?i)^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)`)

// Mirror the browser's portable-path boundary before any remote mutation.
func validUploadPath(p string) bool {
	if !utf8.ValidString(p) || !norm.NFC.IsNormalString(p) || len(p) == 0 || len(p) > 4096 {
		return false
	}
	parts := strings.Split(p, "/")
	if len(parts) > 32 {
		return false
	}
	for _, part := range parts {
		if part == "" || part == "." || part == ".." || len(part) > 255 || strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") || cliDevice.MatchString(part) {
			return false
		}
		for _, r := range part {
			if r < 32 || r >= 127 && r <= 159 || r >= 0x202a && r <= 0x202e || r >= 0x2066 && r <= 0x2069 || strings.ContainsRune(`\<>:"|?*`, r) {
				return false
			}
		}
	}
	return true
}

func parseUploadPlan(data string) (cliUploadPlan, error) {
	var p cliUploadPlan
	invalid := errors.New("Invalid CLI upload selection")
	if len(data) > cliMetadataLimit || json.Unmarshal([]byte(data), &p) != nil || len(p.Entries) == 0 || len(p.Entries) > cliUploadEntryLimit {
		return p, invalid
	}
	if p.Mode != "flat" && p.Mode != "tree" && p.Mode != "zip" {
		return p, invalid
	}
	ids, paths := map[string]bool{}, map[string]string{}
	var total int64
	for _, e := range p.Entries {
		if !cliID.MatchString(e.ID) || ids[e.ID] || !validUploadPath(e.Path) || paths[strings.ToLower(e.Path)] != "" || (e.Kind != "file" && e.Kind != "directory") || e.Size < 0 || e.Size > 1<<53-1 || e.Kind == "directory" && e.Size != 0 {
			return p, invalid
		}
		ids[e.ID], paths[strings.ToLower(e.Path)] = true, e.Kind
		if total > (1<<53-1)-e.Size {
			return p, invalid
		}
		total += e.Size
	}
	for _, e := range p.Entries {
		for parent := path.Dir(e.Path); parent != "."; parent = path.Dir(parent) {
			if paths[strings.ToLower(parent)] != "directory" {
				return p, invalid
			}
		}
	}
	if p.Mode == "zip" && (len(p.Entries) != 1 || p.Entries[0].Kind != "file" || p.Entries[0].Path != "TailShare.zip" || p.Entries[0].Size > 4_000_000_000) {
		return p, invalid
	}
	if p.Mode == "flat" {
		// Flatten only here, after checking the complete selected tree.
		files := p.Entries[:0]
		for _, e := range p.Entries {
			if e.Kind == "file" {
				e.Path = path.Base(e.Path)
				files = append(files, e)
			}
		}
		p.Entries = files
		if len(files) == 0 {
			return p, errors.New("Choose files, ZIP, or folder-tree mode to send empty folders")
		}
	}
	return p, nil
}

func (s *cliShare) prepareUpload(ctx context.Context, p cliUploadPlan) (string, error) {
	s.op.Lock()
	defer s.op.Unlock()
	s.conn.SetDeadline(time.Now().Add(60 * time.Second))
	if s.upload != nil {
		return "", errors.New("CLI upload already started")
	}
	u := &cliUpload{mode: p.Mode, entries: map[string]cliEntry{}, done: map[string]bool{}}
	s.upload = u
	if p.Mode == "tree" {
		var random [16]byte
		if _, err := rand.Read(random[:]); err != nil {
			return "", err
		}
		u.root = "TailShare-" + hex.EncodeToString(random[:])
		if err := s.sftp.Mkdir(u.root); err != nil {
			return "", errors.New("Cannot create an upload folder. Ask the recipient to run tailcat recv --accept-dirs, or send a ZIP")
		}
		// Every folder is freshly created, never adopted after a collision.
		dirs := []string{}
		for _, e := range p.Entries {
			if e.Kind == "directory" {
				dirs = append(dirs, path.Join(u.root, e.Path))
			}
		}
		sort.Slice(dirs, func(i, j int) bool { return strings.Count(dirs[i], "/") < strings.Count(dirs[j], "/") })
		for _, dir := range dirs {
			if ctx.Err() != nil {
				return "", errors.New("CLI upload cancelled")
			}
			if err := s.checkParents(dir); err != nil {
				return "", err
			}
			if err := s.sftp.Mkdir(dir); err != nil {
				return "", errors.New("Cannot create the selected folders. Use a new CLI inbox or send a ZIP")
			}
		}
	}
	for _, e := range p.Entries {
		if e.Kind == "file" {
			e.remote = path.Join(u.root, e.Path)
			u.entries[e.ID] = e
		}
	}
	s.conn.SetDeadline(time.Now().Add(120 * time.Second))
	return u.root, nil
}

func (s *cliShare) openUpload(id string) error {
	s.op.Lock()
	defer s.op.Unlock()
	s.conn.SetDeadline(time.Now().Add(120 * time.Second))
	if s.upload == nil || s.file != nil {
		return errors.New("No CLI upload is ready")
	}
	e, ok := s.upload.entries[id]
	if !ok || s.upload.done[id] {
		return errors.New("File is not in this upload selection")
	}
	if err := s.checkParents(e.remote); err != nil {
		return err
	}
	// Never truncate, append to, or overwrite an existing file, even on an RW server.
	f, err := s.sftp.OpenFile(e.remote, os.O_WRONLY|os.O_CREATE|os.O_EXCL)
	if err != nil {
		return errors.New("CLI refused a new file. Check inbox permissions, available space, and file-name length; existing files are never overwritten")
	}
	s.file, s.current, s.read = f, e, 0
	return nil
}

func (s *cliShare) writeUpload(data []byte) error {
	s.op.Lock()
	defer s.op.Unlock()
	if s.upload == nil || s.file == nil || len(data) == 0 || len(data) > cliBatch || int64(len(data)) > s.current.Size-s.read {
		return errors.New("Invalid CLI upload chunk or length")
	}
	s.conn.SetDeadline(time.Now().Add(120 * time.Second))
	n, err := s.file.Write(data)
	s.read += int64(n)
	if err != nil || n != len(data) {
		return errors.New("CLI write failed. Check receiver disk space; partial files may remain")
	}
	return nil
}

func (s *cliShare) finishUpload() error {
	s.op.Lock()
	defer s.op.Unlock()
	if s.upload == nil || s.file == nil || (s.upload.mode != "zip" && s.read != s.current.Size) {
		return errors.New("CLI upload is incomplete")
	}
	s.conn.SetDeadline(time.Now().Add(120 * time.Second))
	if err := s.file.Close(); err != nil {
		return errors.New("CLI did not confirm the file was closed; partial files may remain")
	}
	s.file = nil
	info, err := s.sftp.Stat(s.current.remote) // recv allows stat of this session's own writes.
	if err != nil || !info.Mode().IsRegular() || info.Size() != s.read {
		return errors.New("CLI could not confirm the uploaded file size; check the inbox before retrying")
	}
	s.upload.done[s.current.ID] = true
	return nil
}

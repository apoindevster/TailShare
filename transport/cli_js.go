//go:build js && wasm

package main

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"syscall/js"
	"time"

	"github.com/tailscale/tailcat"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

type cliSession struct {
	ctx    context.Context
	cancel context.CancelFunc
	mu     sync.Mutex
	share  *cliShare
}

var cliSessions = map[int]*cliSession{}

func registerCLI() {
	js.Global().Set("tailshareCLIStart", js.FuncOf(func(_ js.Value, _ []js.Value) any {
		mu.Lock()
		defer mu.Unlock()
		if len(cliSessions) >= 2 {
			return -1
		}
		ctx, cancel := context.WithCancel(context.Background())
		nextID++
		cliSessions[nextID] = &cliSession{ctx: ctx, cancel: cancel}
		return nextID
	}))
	js.Global().Set("tailshareCLIClose", js.FuncOf(func(_ js.Value, args []js.Value) any {
		mu.Lock()
		s := cliSessions[args[0].Int()]
		delete(cliSessions, args[0].Int())
		mu.Unlock()
		if s != nil {
			s.cancel()
			go func() {
				s.mu.Lock()
				defer s.mu.Unlock()
				if s.share != nil {
					s.share.close()
				}
			}()
		}
		return nil
	}))
	js.Global().Set("tailshareCLIConnect", js.FuncOf(cliConnect))
	js.Global().Set("tailshareCLIFile", js.FuncOf(cliFile))
	js.Global().Set("tailshareCLIDirectory", js.FuncOf(cliDirectory))
	js.Global().Set("tailshareCLIUpload", js.FuncOf(cliUploadFile))
}

func cliState(id int) *cliSession {
	mu.Lock()
	defer mu.Unlock()
	return cliSessions[id]
}

func cliConnect(_ js.Value, args []js.Value) any {
	s := cliState(args[0].Int())
	address := args[1].String()
	mapURL := args[2].String()
	uploadJSON := ""
	if len(args) > 3 && args[3].Type() == js.TypeString {
		uploadJSON = args[3].String()
	}
	return promise(func() (any, error) {
		if s == nil || s.ctx.Err() != nil {
			return nil, errors.New("CLI connection cancelled")
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.share != nil {
			return nil, errors.New("CLI session is already connected")
		}
		var plan cliUploadPlan
		if uploadJSON != "" {
			var err error
			plan, err = parseUploadPlan(uploadJSON)
			if err != nil {
				return nil, err
			}
		}
		ci, err := tailcat.ParseAddr(tailcat.Addr(address))
		if err != nil {
			return nil, errors.New("Invalid Tailcat CLI key")
		}
		if ci.PresharedKey.IsZero() {
			return nil, errors.New("Use a current tailcat CLI with the default --psk=true protection")
		}
		if len(ci.Region) != 0 || ci.RegionID < 301 || ci.RegionID > 304 {
			return nil, errors.New("Use the default public Tailcat relays without --full-address; custom relays are not supported by this site")
		}
		cl := &tailcat.Client{Server: tailcat.Addr(address), Key: key.NewNode(), DERPMapURL: mapURL, Logf: logger.Discard}
		context.AfterFunc(s.ctx, func() { cl.Close() })
		ctx, cancel := context.WithTimeout(s.ctx, 60*time.Second)
		defer cancel()
		conn, err := cl.DialTCPPort(ctx, 22)
		if err != nil {
			cl.Close()
			return nil, errors.New("Cannot reach the CLI. Keep tailcat serve files or tailcat recv running and reconnect")
		}
		context.AfterFunc(s.ctx, func() { conn.Close() })
		stopTimeout := context.AfterFunc(ctx, func() { conn.Close() })
		defer stopTimeout()
		share, err := openCLI(conn)
		if err != nil {
			cl.Close()
			return nil, err
		}
		if uploadJSON != "" {
			root, err := share.prepareUpload(ctx, plan)
			if err != nil || ctx.Err() != nil {
				share.close()
				cl.Close()
				if err != nil {
					return nil, err
				}
				return nil, errors.New("CLI upload cancelled or timed out")
			}
			s.share = share
			return root, nil
		}
		catalog, err := share.directoryPage(ctx, "open", "")
		if err != nil || ctx.Err() != nil {
			share.close()
			cl.Close()
			if err != nil {
				return nil, err
			}
			return nil, errors.New("CLI connection cancelled or timed out")
		}
		s.share = share
		encoded, err := json.Marshal(catalog)
		if err != nil {
			return nil, err
		}
		return string(encoded), nil
	})
}

func cliUploadFile(_ js.Value, args []js.Value) any {
	s := cliState(args[0].Int())
	op := args[1].String()
	id := ""
	var data []byte
	if op == "open" && len(args) > 2 {
		id = args[2].String()
	}
	if op == "write" && len(args) > 2 && args[2].InstanceOf(js.Global().Get("Uint8Array")) {
		n := args[2].Get("byteLength").Int()
		if n > 0 && n <= cliBatch {
			data = make([]byte, n)
			js.CopyBytesToGo(data, args[2])
		}
	}
	return promise(func() (any, error) {
		if s == nil || s.ctx.Err() != nil {
			return nil, errors.New("CLI upload cancelled or disconnected")
		}
		s.mu.Lock()
		share := s.share
		s.mu.Unlock()
		if share == nil {
			return nil, errors.New("Connect to the CLI receiver first")
		}
		switch op {
		case "open":
			return js.Undefined(), share.openUpload(id)
		case "write":
			return js.Undefined(), share.writeUpload(data)
		case "finish":
			return js.Undefined(), share.finishUpload()
		default:
			return nil, errors.New("Unsupported CLI upload operation")
		}
	})
}

func cliFile(_ js.Value, args []js.Value) any {
	s := cliState(args[0].Int())
	op := args[1].String()
	entryID := ""
	if len(args) > 2 {
		entryID = args[2].String()
	}
	return promise(func() (any, error) {
		if s == nil || s.ctx.Err() != nil {
			return nil, errors.New("CLI connection is closed")
		}
		s.mu.Lock()
		share := s.share
		s.mu.Unlock()
		if share == nil {
			return nil, errors.New("Reconnect to the CLI sender")
		}
		switch op {
		case "open":
			return js.Undefined(), share.openFile(entryID)
		case "read":
			data, err := share.readFile()
			if err != nil || data == nil {
				return js.Null(), err
			}
			out := js.Global().Get("Uint8Array").New(len(data))
			js.CopyBytesToJS(out, data)
			return out, nil
		case "finish":
			return js.Undefined(), share.finishFile()
		default:
			return nil, errors.New("Unsupported CLI file operation")
		}
	})
}

func cliDirectory(_ js.Value, args []js.Value) any {
	s := cliState(args[0].Int())
	op := args[1].String()
	value := args[2].String()
	return promise(func() (any, error) {
		if s == nil || s.ctx.Err() != nil {
			return nil, errors.New("CLI connection is closed")
		}
		s.mu.Lock()
		share := s.share
		s.mu.Unlock()
		if share == nil {
			return nil, errors.New("Reconnect to the CLI sender")
		}
		page, err := share.directoryPage(s.ctx, op, value)
		if err != nil {
			var folderError *cliFolderError
			if errors.As(err, &folderError) {
				encoded, _ := json.Marshal(map[string]string{"error": err.Error()})
				return string(encoded), nil
			}
			s.cancel()
			return nil, err
		}
		encoded, err := json.Marshal(page)
		return string(encoded), err
	})
}

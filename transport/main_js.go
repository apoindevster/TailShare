//go:build js && wasm

// TailShare's bounded browser bridge. Based on the Tailcat web bridge API.
// Tailcat is Copyright Tailscale Inc & contributors, BSD-3-Clause.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"syscall/js"
	"time"

	"github.com/tailscale/tailcat"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

const port = 1443
const chunk = 64 << 10

var mu sync.Mutex
var nextID int
var streams = map[int]*stream{}
var listeners = map[int]*tailcat.Server{}

type stream struct {
	c      net.Conn
	client *tailcat.Client
}

func allocate(s *stream) int {
	mu.Lock()
	defer mu.Unlock()
	nextID++
	streams[nextID] = s
	return nextID
}
func main() {
	registerCLI()
	js.Global().Set("tailshareListen", js.FuncOf(listen))
	js.Global().Set("tailshareDial", js.FuncOf(dial))
	js.Global().Set("tailshareIO", js.FuncOf(operation))
	js.Global().Set("tailshareStop", js.FuncOf(stop))
	if f := js.Global().Get("onTailcatReady"); f.Type() == js.TypeFunction {
		f.Invoke()
	}
	select {}
}
func listen(_ js.Value, args []js.Value) any {
	opts := args[0]
	mapURL := opts.Get("derpMapURL").String()
	incoming := opts.Get("onConnection")
	return promise(func() (any, error) {
		pk := tailcat.NewPrivateKey()
		pk.Public.RegionID = -1
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		ci := pk.Public
		if err := ci.Expand(ctx, tailcat.ExpandForServer, tailcat.DERPMapURL(mapURL)); err != nil {
			return nil, err
		}
		region := ci.Region[0]
		pk.Public.RegionID = region.RegionID
		server := &tailcat.Server{Key: pk.Private, PresharedKey: pk.Public.PresharedKey, Region: region, Logf: logger.Discard}
		server.OnTCP = func(p uint16) func(net.Conn) {
			if p != port {
				return nil
			}
			return func(c net.Conn) {
				mu.Lock()
				count := len(streams)
				mu.Unlock()
				if count >= 8 {
					c.Close()
					return
				}
				id := allocate(&stream{c: c})
				incoming.Invoke(id)
			}
		}
		if err := server.Start(); err != nil {
			server.Close()
			return nil, err
		}
		mu.Lock()
		nextID++
		id := nextID
		listeners[id] = server
		mu.Unlock()
		return map[string]any{"id": id, "addr": string(pk.Public.Addr())}, nil
	})
}
func dial(_ js.Value, args []js.Value) any {
	opts := args[0]
	addr := opts.Get("addr").String()
	mapURL := opts.Get("derpMapURL").String()
	return promise(func() (any, error) {
		client := &tailcat.Client{Server: tailcat.Addr(addr), Key: key.NewNode(), DERPMapURL: mapURL, Logf: logger.Discard}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		for {
			pingCtx, pingCancel := context.WithTimeout(ctx, 5*time.Second)
			_, err := client.Ping(pingCtx)
			pingCancel()
			if err == nil {
				break
			}
			if ctx.Err() != nil {
				client.Close()
				return nil, errors.New("Cannot reach sender. Check the link and keep both tabs open.")
			}
		}
		c, err := client.DialTCPPort(ctx, port)
		if err != nil {
			client.Close()
			return nil, err
		}
		return allocate(&stream{c: c, client: client}), nil
	})
}
func operation(_ js.Value, args []js.Value) any {
	op, id := args[0].String(), args[1].Int()
	mu.Lock()
	s := streams[id]
	if op == "close" {
		delete(streams, id)
	}
	mu.Unlock()
	if s == nil {
		if op == "close" {
			return nil
		}
		return rejected(errors.New("Connection is closed."))
	}
	if op == "close" {
		s.c.Close()
		if s.client != nil {
			s.client.Close()
		}
		return nil
	}
	var data []byte
	if op == "write" {
		if len(args) != 3 || !args[2].InstanceOf(js.Global().Get("Uint8Array")) {
			return rejected(errors.New("Expected bytes."))
		}
		n := args[2].Get("length").Int()
		// One data frame: 64 KiB payload plus its five-byte header. Reads remain
		// capped at chunk; the stream decoder handles arbitrary fragmentation.
		if n < 1 || n > chunk+5 {
			return rejected(errors.New("Chunk limit exceeded."))
		}
		data = make([]byte, n)
		js.CopyBytesToGo(data, args[2])
	}
	return promise(func() (any, error) {
		switch op {
		case "read":
			s.c.SetReadDeadline(time.Now().Add(15 * time.Minute))
			buf := make([]byte, chunk)
			n, err := s.c.Read(buf)
			if n > 0 {
				out := js.Global().Get("Uint8Array").New(n)
				js.CopyBytesToJS(out, buf[:n])
				return out, nil
			}
			if errors.Is(err, io.EOF) {
				return js.Null(), nil
			}
			return nil, err
		case "write":
			s.c.SetWriteDeadline(time.Now().Add(2 * time.Minute))
			for len(data) > 0 {
				n, err := s.c.Write(data)
				if err != nil {
					return nil, err
				}
				if n == 0 {
					return nil, io.ErrShortWrite
				}
				data = data[n:]
			}
			return js.Undefined(), nil
		default:
			return nil, fmt.Errorf("Unknown operation")
		}
	})
}
func stop(_ js.Value, args []js.Value) any {
	id := args[0].Int()
	mu.Lock()
	server := listeners[id]
	delete(listeners, id)
	mu.Unlock()
	if server != nil {
		server.Close()
	}
	return nil
}
func promise(f func() (any, error)) js.Value {
	handler := js.FuncOf(func(_ js.Value, args []js.Value) any {
		resolve, reject := args[0], args[1]
		go func() {
			value, err := f()
			if err != nil {
				reject.Invoke(js.Global().Get("Error").New(err.Error()))
			} else {
				resolve.Invoke(value)
			}
		}()
		return nil
	})
	result := js.Global().Get("Promise").New(handler)
	handler.Release()
	return result
}
func rejected(err error) js.Value {
	return js.Global().Get("Promise").Call("reject", js.Global().Get("Error").New(err.Error()))
}

package main

import (
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

//go:embed web
var webFS embed.FS

func main() {
	addr := flag.String("addr", ":8080", "адрес сервера")
	gamePath := flag.String("game", "game.json", "файл с вопросами")
	mediaDir := flag.String("media", "media", "папка с картинками, аудио и видео")
	statePath := flag.String("state", "state.json", "файл сохранения прогресса игры")
	flag.Parse()

	_, warns, err := loadGame(*gamePath, *mediaDir)
	if err != nil {
		log.Fatalf("ошибка в %s:\n%v", *gamePath, err)
	}
	for _, w := range warns {
		log.Printf("предупреждение: %s", w)
	}

	store := &stateStore{path: *statePath}
	mux := http.NewServeMux()

	// game.json перечитывается на каждый запрос: поправили вопрос — обновили страницу.
	mux.HandleFunc("GET /api/game", func(w http.ResponseWriter, r *http.Request) {
		g, warns, err := loadGame(*gamePath, *mediaDir)
		if err != nil {
			log.Printf("ошибка в %s:\n%v", *gamePath, err)
			http.Error(w, err.Error(), http.StatusUnprocessableEntity)
			return
		}
		writeJSON(w, struct {
			*Game
			Warnings []string `json:"warnings,omitempty"`
		}{g, warns})
	})
	mux.HandleFunc("GET /api/state", store.get)
	mux.HandleFunc("PUT /api/state", store.put)
	mux.HandleFunc("POST /api/log", clientLog)

	mux.Handle("GET /media/", http.StripPrefix("/media/", http.FileServer(http.Dir(*mediaDir))))

	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatal(err)
	}
	mux.Handle("GET /", noCache(http.FileServer(http.FS(sub))))

	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		if errors.Is(err, syscall.EADDRINUSE) {
			log.Fatalf("порт %s уже занят — скорее всего, игра уже запущена в другом терминале.\n"+
				"Остановите её (Ctrl+C) или запустите на другом порту: make dev PORT=8081", portOf(*addr))
		}
		log.Fatalf("не удалось открыть %s: %v", *addr, err)
	}
	log.Printf("Своя игра запущена: http://localhost%s", portOf(*addr))
	for _, ip := range lanIPs() {
		log.Printf("  в локальной сети: http://%s%s", ip, portOf(*addr))
	}
	log.Printf("вопросы: %s, медиа: %s/, сохранение: %s", *gamePath, *mediaDir, *statePath)
	log.Fatal(http.Serve(ln, logRequests(mux)))
}

// statusWriter запоминает код ответа для лога.
type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

// logRequests пишет в лог каждый запрос: метод, путь, код ответа, время.
// Сохранения прогресса логируются только при ошибке, чтобы не засорять вывод.
func logRequests(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		h.ServeHTTP(sw, r)
		quiet := r.URL.Path == "/api/log" || (r.URL.Path == "/api/state" && r.Method == http.MethodPut)
		if quiet && sw.status < 400 {
			return
		}
		log.Printf("%s %s → %d (%s)", r.Method, r.URL.Path, sw.status, time.Since(start).Round(time.Millisecond))
	})
}

// clientLog принимает события и ошибки из браузера и пишет их в лог сервера.
func clientLog(w http.ResponseWriter, r *http.Request) {
	var m struct {
		Level string `json:"level"`
		Msg   string `json:"msg"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&m); err != nil {
		http.Error(w, "некорректный JSON", http.StatusBadRequest)
		return
	}
	prefix := "[игра]"
	if m.Level == "error" {
		prefix = "[ОШИБКА в браузере]"
	}
	log.Printf("%s %s", prefix, m.Msg)
	w.WriteHeader(http.StatusNoContent)
}

type stateStore struct {
	mu   sync.Mutex
	path string
}

func (s *stateStore) get(w http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := os.ReadFile(s.path)
	if errors.Is(err, fs.ErrNotExist) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(data)
}

func (s *stateStore) put(w http.ResponseWriter, r *http.Request) {
	data, err := io.ReadAll(io.LimitReader(r.Body, 5<<20))
	if err != nil || !json.Valid(data) {
		http.Error(w, "некорректный JSON", http.StatusBadRequest)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		log.Printf("не удалось сохранить прогресс: %v", err)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := os.Rename(tmp, s.path); err != nil {
		log.Printf("не удалось сохранить прогресс: %v", err)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("writeJSON: %v", err)
	}
}

func noCache(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		h.ServeHTTP(w, r)
	})
}

func portOf(addr string) string {
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		return addr
	}
	return ":" + port
}

func lanIPs() []string {
	var ips []string
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && !n.IP.IsLoopback() && n.IP.To4() != nil && n.IP.IsPrivate() {
			ips = append(ips, n.IP.String())
		}
	}
	return ips
}

// mediaExists проверяет, что файл есть в папке media (ссылки http(s) не проверяются).
func mediaExists(mediaDir, p string) bool {
	if isURL(p) {
		return true
	}
	_, err := os.Stat(filepath.Join(mediaDir, filepath.FromSlash(p)))
	return err == nil
}

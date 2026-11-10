package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
)

type Game struct {
	Title    string   `json:"title"`
	Players  []string `json:"players"`
	Settings Settings `json:"settings"`
	Rounds   []Round  `json:"rounds"`
	Final    *Final   `json:"final,omitempty"`
}

type Settings struct {
	Timer          int    `json:"timer"`                // секунд на обычный вопрос, 0 — без таймера
	FinalTimer     int    `json:"finalTimer"`           // секунд на финальный вопрос
	AutoStartTimer *bool  `json:"autoStartTimer"`       // запускать таймер сразу при показе вопроса
	WrongSound     string `json:"wrongSound,omitempty"` // свой звук неправильного ответа (файл в media), иначе встроенный
}

type Round struct {
	Name   string  `json:"name"`
	Themes []Theme `json:"themes"`
}

type Theme struct {
	Name      string     `json:"name"`
	Questions []Question `json:"questions"`
}

// Content — то, что показывается на экране вопроса и ответа.
type Content struct {
	Text        string `json:"text,omitempty"`
	Image       string `json:"image,omitempty"`
	Audio       string `json:"audio,omitempty"`
	Video       string `json:"video,omitempty"`
	Answer      string `json:"answer,omitempty"`
	AnswerImage string `json:"answerImage,omitempty"`
}

type Question struct {
	Value    int    `json:"value"`
	Type     string `json:"type,omitempty"`     // "" | "cat" | "auction"
	CatTheme string `json:"catTheme,omitempty"` // тема, которую объявляют для «Кота в мешке»
	Content
}

type Final struct {
	Themes []FinalTheme `json:"themes"`
}

type FinalTheme struct {
	Name string `json:"name"`
	Content
}

func loadGame(path, mediaDir string) (*Game, []string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, err
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var g Game
	if err := dec.Decode(&g); err != nil {
		return nil, nil, describeJSONErr(data, err)
	}
	g.applyDefaults()
	errs, warns := g.validate(mediaDir)
	if len(errs) > 0 {
		return nil, warns, errors.New(strings.Join(errs, "\n"))
	}
	return &g, warns, nil
}

func (g *Game) applyDefaults() {
	if g.Title == "" {
		g.Title = "Своя игра"
	}
	if g.Settings.Timer == 0 {
		g.Settings.Timer = 20
	}
	if g.Settings.Timer < 0 {
		g.Settings.Timer = 0
	}
	if g.Settings.FinalTimer == 0 {
		g.Settings.FinalTimer = 60
	}
	if g.Settings.FinalTimer < 0 {
		g.Settings.FinalTimer = 0
	}
	if g.Settings.AutoStartTimer == nil {
		t := true
		g.Settings.AutoStartTimer = &t
	}
	for i := range g.Rounds {
		if g.Rounds[i].Name == "" {
			g.Rounds[i].Name = fmt.Sprintf("Раунд %d", i+1)
		}
	}
}

func (g *Game) validate(mediaDir string) (errs, warns []string) {
	if len(g.Players) == 0 {
		errs = append(errs, "players: нужен хотя бы один игрок")
	}
	if len(g.Rounds) == 0 {
		errs = append(errs, "rounds: нужен хотя бы один раунд")
	}

	checkContent := func(where string, c Content) {
		if c.Text == "" && c.Image == "" && c.Audio == "" && c.Video == "" {
			errs = append(errs, where+": нет ни text, ни image/audio/video")
		}
		if c.Answer == "" && c.AnswerImage == "" {
			errs = append(errs, where+": нет ни answer, ни answerImage")
		}
		for _, m := range []string{c.Image, c.Audio, c.Video, c.AnswerImage} {
			if m != "" && !mediaExists(mediaDir, m) {
				warns = append(warns, fmt.Sprintf("%s: файл %q не найден в папке media", where, m))
			}
		}
	}

	if s := g.Settings.WrongSound; s != "" && !mediaExists(mediaDir, s) {
		warns = append(warns, fmt.Sprintf("settings.wrongSound: файл %q не найден в папке media — будет встроенный звук", s))
	}

	for _, r := range g.Rounds {
		rw := r.Name
		if len(r.Themes) == 0 {
			errs = append(errs, rw+": нет тем")
		}
		for ti, t := range r.Themes {
			tw := fmt.Sprintf("%s → тема %d «%s»", rw, ti+1, t.Name)
			if t.Name == "" {
				errs = append(errs, tw+": пустое название темы")
			}
			if len(t.Questions) == 0 {
				errs = append(errs, tw+": нет вопросов")
			}
			for qi, q := range t.Questions {
				qw := fmt.Sprintf("%s → вопрос %d", tw, qi+1)
				if q.Value <= 0 {
					errs = append(errs, qw+": value должен быть больше 0")
				}
				switch q.Type {
				case "", "cat", "auction":
				default:
					errs = append(errs, fmt.Sprintf("%s: неизвестный type %q (можно \"cat\" или \"auction\")", qw, q.Type))
				}
				checkContent(qw, q.Content)
			}
		}
	}

	if g.Final != nil {
		if len(g.Final.Themes) == 0 {
			errs = append(errs, "final: нет тем")
		}
		for i, t := range g.Final.Themes {
			w := fmt.Sprintf("Финал → тема %d «%s»", i+1, t.Name)
			if t.Name == "" {
				errs = append(errs, w+": пустое название темы")
			}
			checkContent(w, t.Content)
		}
	}
	return errs, warns
}

func isURL(s string) bool {
	return strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "https://")
}

// describeJSONErr добавляет к ошибке разбора номер строки и столбца.
func describeJSONErr(data []byte, err error) error {
	var offset int64 = -1
	var syn *json.SyntaxError
	var typ *json.UnmarshalTypeError
	switch {
	case errors.As(err, &syn):
		offset = syn.Offset
	case errors.As(err, &typ):
		offset = typ.Offset
	}
	if offset < 0 {
		return err
	}
	line, col := 1, 1
	for _, b := range data[:min(int(offset), len(data))] {
		if b == '\n' {
			line++
			col = 1
		} else {
			col++
		}
	}
	return fmt.Errorf("строка %d, столбец %d: %w", line, col, err)
}

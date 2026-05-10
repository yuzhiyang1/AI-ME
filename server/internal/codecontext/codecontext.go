package codecontext

import (
	"fmt"
	"regexp"
	"strings"
)

const (
	TypeDefaultRepo = "default_repo"
	TypeLocalPath   = "local_path"
)

var (
	posixAbsPathRE   = regexp.MustCompile(`^/`)
	windowsAbsPathRE = regexp.MustCompile(`^[A-Za-z]:[\\/]`)
	uncAbsPathRE     = regexp.MustCompile(`^\\\\`)
)

type Context struct {
	Type string `json:"type"`
	Path string `json:"path,omitempty"`
}

func Default() Context {
	return Context{Type: TypeDefaultRepo}
}

func Normalize(input *Context) (Context, error) {
	if input == nil || strings.TrimSpace(input.Type) == "" {
		return Default(), nil
	}

	switch strings.TrimSpace(input.Type) {
	case TypeDefaultRepo:
		return Default(), nil
	case TypeLocalPath:
		path := strings.TrimSpace(input.Path)
		if path == "" {
			return Context{}, fmt.Errorf("local path is required")
		}
		if !IsCrossPlatformAbsPath(path) {
			return Context{}, fmt.Errorf("local path must be an absolute path")
		}
		return Context{
			Type: TypeLocalPath,
			Path: path,
		}, nil
	default:
		return Context{}, fmt.Errorf("unsupported code context type")
	}
}

func IsCrossPlatformAbsPath(path string) bool {
	trimmed := strings.TrimSpace(path)
	return posixAbsPathRE.MatchString(trimmed) ||
		windowsAbsPathRE.MatchString(trimmed) ||
		uncAbsPathRE.MatchString(trimmed)
}

func (c Context) IsLocalPath() bool {
	return c.Type == TypeLocalPath && strings.TrimSpace(c.Path) != ""
}

//go:build !windows

package execenv

func writeMulticaWrapper(_ string) error {
	return nil
}

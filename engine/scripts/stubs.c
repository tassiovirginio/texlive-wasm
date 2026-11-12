/*
 * Stubs for libc functions that TL references but Emscripten's libc doesn't
 * provide. Linked into engines that need them (e.g. xdvipdfmx for getpass).
 *
 * These all return failure or empty values — TL won't actually need to call
 * them in any normal compile flow (encryption is unsupported in the WASM
 * build, signal handling is irrelevant, etc.).
 */

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

/* xdvipdfmx uses getpass() for PDF encryption password prompts. We don't
   support encryption in the WASM build, so always return NULL. */
char *getpass(const char *prompt) {
    (void)prompt;
    fprintf(stderr, "getpass: not supported in the WASM build\n");
    return NULL;
}

/* ICU data stub for engines that link libicuuc/libicudata.
 *
 * The real `icudt<VV>_dat` symbol is a ~30 MB binary blob produced by ICU's
 * `pkgdata` from per-locale resource bundles. In our cross-build those .res.o
 * files are emitted as ELF objects by genccode, which wasm-ld can't link.
 *
 * We provide a minimal valid ICU data header so libicuuc loads cleanly. At
 * runtime, ICU calls that need locale data (numbers, dates, collation tables)
 * will return U_MISSING_RESOURCE_ERROR. The xetex use of ICU is mostly for
 * harfbuzz/normalization which works with the embedded BMP tables in
 * libicuuc itself; it does not require icudt<VV>_dat to be populated.
 *
 * A real fix would be to switch ICU to `--with-data-packaging=common`, ship
 * the icudt<VV>l.dat file at /icudt<VV>l.dat in MEMFS, and call
 * udata_setCommonData() from JS. That's Phase 2 — for now the engine links
 * and runs.
 *
 * The header layout below matches ICU's UDataInfo struct enough to satisfy
 * libicuuc's `u_getMainInfo` validation. ICU versions 76+ all use the same
 * 32-byte UDataInfo prefix.
 */

/* Empty ICU data file: 20-byte MappedData header + 32-byte UDataInfo +
 * 12-byte padding; total 64 bytes. ICU sees this, finds no entries, and
 * returns U_MISSING_RESOURCE_ERROR for lookups. */
__attribute__((aligned(16)))
const uint8_t icudt76_dat[64] = {
    0x20, 0x00, /* headerSize */
    0xda, 0x27, /* magic1, magic2 */
    /* UDataInfo (20 bytes) */
    0x14, 0x00, /* size = 20 */
    0x00, 0x00, /* reserved */
    0x00,       /* isBigEndian = 0 (little-endian) */
    0x00,       /* charsetFamily = 0 (U_ASCII_FAMILY) */
    0x02,       /* sizeofUChar = 2 */
    0x00,       /* reserved */
    0x00, 0x00, 0x00, 0x00, /* dataFormat */
    0x00, 0x00, 0x00, 0x00, /* formatVersion */
    0x00, 0x00, 0x00, 0x00, /* dataVersion */
    /* padding to total 64 bytes */
    0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0,
    0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0,
    0,0,0,0
};

/* Alias for the version we currently build against (TL 2026 ships ICU 76,
 * but the icu-src in TL 2026 advertises 78 in icudt<VV>_dat name). */
__attribute__((alias("icudt76_dat")))
extern const uint8_t icudt78_dat[64];

/* Weak no-op stub for udata_setCommonData_78.
 *
 * We export _udata_setCommonData_78 globally so the JS-side runtime can load
 * the real icudt78l.dat at startup for ICU-using engines (xelatex, bibtexu).
 * For engines that don't link ICU (pdflatex, lualatex, makeindex, xdvipdfmx),
 * this stub satisfies the export and is a no-op. ICU's real symbol overrides
 * via standard archive-link strong-beats-weak rules. */
__attribute__((weak))
void udata_setCommonData_78(const void *data, int *errorCode) {
    (void)data;
    if (errorCode) *errorCode = 0;
}

/* WASI lacks fork/exec — kpathsea's tex-make.c uses these for on-demand
 * mktex script invocation, which we don't ship in the WASM bundle anyway.
 * Stubs return -1 so the fork() guard in tex-make.c bails out gracefully. */
#ifdef __wasi__
#include <errno.h>
#include <unistd.h>
#include <sys/types.h>
typedef int pid_t_shim_;
pid_t fork(void) { errno = ENOSYS; return -1; }
pid_t vfork(void) { errno = ENOSYS; return -1; }
pid_t wait(int *s) { (void)s; errno = ECHILD; return -1; }
pid_t waitpid(pid_t p, int *s, int o) { (void)p; (void)s; (void)o; errno = ECHILD; return -1; }
int execvp(const char *f, char *const a[]) { (void)f; (void)a; errno = ENOSYS; return -1; }
int execv(const char *f, char *const a[]) { (void)f; (void)a; errno = ENOSYS; return -1; }
int execve(const char *f, char *const a[], char *const e[]) { (void)f; (void)a; (void)e; errno = ENOSYS; return -1; }
int pipe(int fds[2]) { (void)fds; errno = ENOSYS; return -1; }
int dup(int fd) { (void)fd; errno = EBADF; return -1; }
int dup2(int o, int n) { (void)o; (void)n; errno = EBADF; return -1; }
int kill(pid_t p, int s) { (void)p; (void)s; errno = ENOSYS; return -1; }
/* Single-threaded WASI: flockfile/funlockfile are no-ops. */
void flockfile(FILE *f) { (void)f; }
int ftrylockfile(FILE *f) { (void)f; return 0; }
void funlockfile(FILE *f) { (void)f; }
struct passwd;
struct passwd *getpwnam(const char *n) { (void)n; return 0; }
struct passwd *getpwuid(unsigned u) { (void)u; return 0; }
uid_t getuid(void) { return 0; }
uid_t geteuid(void) { return 0; }
gid_t getgid(void) { return 0; }
gid_t getegid(void) { return 0; }
/* \write18 / shell-escape — disabled in WASM build. */
FILE *popen(const char *c, const char *m) { (void)c; (void)m; errno = ENOSYS; return 0; }
int pclose(FILE *f) { (void)f; errno = ECHILD; return -1; }
int system(const char *c) { (void)c; errno = ENOSYS; return -1; }
#endif

/* Apply a real libc environment override before main, including reproducible
 * timestamps read with getenv rather than kpathsea configuration. */
#include <stdlib.h>
int texlive_setenv(const char *key, const char *value) {
    return setenv(key, value, 1);
}

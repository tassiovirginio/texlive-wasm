# Emscripten target — the browser/Tauri build path.
#
# Approach (heavily inspired by busytex's MIT-licensed Makefile, simplified
# and refactored for per-engine output):
#
#   1. Out-of-tree build dir per engine: build/<engine>/emscripten/.
#   2. emconfigure ../texlive-source/configure with --disable-all-pkgs and
#      --enable-<engine>. TL's own configure walks its dep tree.
#   3. emmake make -j to compile all required libs and the engine.
#   4. Final emcc link step picks up the engine's busymain entry point and
#      emits engine.wasm + engine.js loader.
#
# Per-engine recipes follow a common shape via the ENGINE_TEMPLATE_em macro.

# Top-level path to TL source (symlink set up by `make source`).
TL_SOURCE := $(SOURCE_DIR)/texlive-source

# Where Emscripten lives in the container.
EMSDK_ENV := source /opt/emsdk/emsdk_env.sh >/dev/null 2>&1 &&

# Compile flags shared by every engine.
#   -Oz                          smallest binary
#   -sWASMFS                     replaces the legacy MEMFS-only FS
#   -sENVIRONMENT=worker         we always run from a Web Worker
#   -sMODULARIZE -sEXPORT_ES6    so the JS glue is ESM, lazy-instantiable
#   -sFORCE_FILESYSTEM           ensures FS is included even with WASMFS
#   -sALLOW_MEMORY_GROWTH        TeX engines grow rapidly under heavy docs
#   -sINITIAL_MEMORY=32MB        small floor: mobile WebViews pay for every
#                                worker's heap; growth reallocs on non-shared
#                                memory are cheap (a handful of geometric
#                                steps per run)
#   -sEXIT_RUNTIME=0             we callMain repeatedly; don't kill the heap
#   -sEXPORTED_RUNTIME_METHODS   what our worker.ts uses
#   -sEXPORTED_FUNCTIONS         _main + _malloc/_free for stdin/files
# Threading is governed by ENABLE_THREADS in common.mk (default off — see
# the rationale there; a threaded build needs a cross-origin-isolated page).
EMCC_COMMON := \
	$(OPT) \
	$(THREAD_LDFLAGS) \
	-sWASMFS=1 \
	-sALLOW_MEMORY_GROWTH=1 \
	-sMEMORY_GROWTH_GEOMETRIC_STEP=0.5 \
	-sINITIAL_MEMORY=33554432 \
	-sMAXIMUM_MEMORY=$(MAX_MEMORY) \
	-sSTACK_SIZE=8388608 \
	-sMODULARIZE=1 \
	-sEXPORT_ES6=1 \
	-sEXPORTED_RUNTIME_METHODS=FS,callMain,PATH,HEAPU8,HEAPU32,stringToUTF8 \
	-sEXPORTED_FUNCTIONS=_main,_malloc,_free,_udata_setCommonData_78,_texlive_mount_lazy,_texlive_touch,_texlive_setenv \
	-sENVIRONMENT=worker,web,node \
	-sFORCE_FILESYSTEM=1 \
	-sEXIT_RUNTIME=0 \
	-sINVOKE_RUN=0

# Link inputs that live outside the TL tree, plus the makefiles that spell the
# link out. Without these as prerequisites the .wasm looks up to date after any
# edit to the lazy-FS glue, the stubs or the flags above — which is how an
# artifact missing _texlive_mount_lazy survives a rebuild and silently degrades
# to the eager path at runtime. The recipe is monolithic (configure + make +
# link), so a touched prerequisite re-runs all of it: correctness over speed,
# and CI builds from a clean tree anyway.
EM_LINK_DEPS := \
	$(ROOT)/scripts/wasmfs-lazy.c \
	$(ROOT)/scripts/wasmfs-lazy-lib.js \
	$(ROOT)/scripts/stubs.c \
	$(ROOT)/scripts/stubs_force.h \
	$(MAKEFILE_LIST)

# Engines we know how to configure today. Anything not in this list builds as
# a no-op stub (so `make all` still enumerates cleanly, but only listed
# engines do real work).
TL_CONFIGURE_FLAG_pdflatex := --enable-pdftex
TL_CONFIGURE_FLAG_xelatex  := --enable-xetex
TL_CONFIGURE_FLAG_lualatex := --enable-luahbtex --enable-luatex
TL_CONFIGURE_FLAG_bibtexu  := --enable-bibtex-x
TL_CONFIGURE_FLAG_xdvipdfmx:= --enable-dvipdfm-x
TL_CONFIGURE_FLAG_makeindex:= --enable-makeindexk
TL_CONFIGURE_FLAG_synctex  := --enable-pdftex

# Engines that link libicu and therefore depend on the icu-native pre-build.
TL_NEEDS_ICU_pdflatex :=
TL_NEEDS_ICU_xelatex  := 1
TL_NEEDS_ICU_lualatex :=
TL_NEEDS_ICU_bibtexu  := 1
TL_NEEDS_ICU_xdvipdfmx:=
TL_NEEDS_ICU_makeindex:=
TL_NEEDS_ICU_synctex  :=

# Per-engine lib subdir lists. After TL's top-level configure builds the
# libs/Makefile, we sed MAKE_SUBDIRS down to only these subdirs. Libs not in
# the list are skipped at make time, and we pre-create empty header
# placeholders for them so web2c's hardcoded "rebuild lib X" rules don't fire.
TL_LIBS_pdflatex := zlib libpng pplib zziplib xpdf
TL_LIBS_xelatex  := zlib libpng freetype2 graphite2 harfbuzz icu teckit pplib zziplib xpdf
TL_LIBS_lualatex := zlib libpng lua53 freetype2 graphite2 harfbuzz pplib zziplib xpdf
TL_LIBS_bibtexu  := icu
TL_LIBS_xdvipdfmx:= zlib libpng freetype2
TL_LIBS_makeindex:=
TL_LIBS_synctex  := zlib

# Per-engine texk subdir whitelists. We deliberately EXCLUDE web2c from the
# SUBDIRS recursion (web2c's `all` target builds too much extra stuff like
# luaharfbuzz); we drive web2c directly via `make -C texk/web2c <target>`
# after libs/ and the other texk subdirs are done.
TL_TEXK_pdflatex := kpathsea ptexenc
TL_TEXK_xelatex  := kpathsea ptexenc
TL_TEXK_lualatex := kpathsea ptexenc
TL_TEXK_bibtexu  := kpathsea bibtex-x
TL_TEXK_xdvipdfmx:= kpathsea dvipdfm-x
TL_TEXK_makeindex:= kpathsea makeindexk
TL_TEXK_synctex  := kpathsea

# Engines that need wasm fontconfig (only xelatex). Wired via TL_NEEDS_FC_*
# in the recipe; injects -I/path/to/fontconfig into CFLAGS/CXXFLAGS so TL's
# xetex source can find <fontconfig/fontconfig.h> at compile time.
TL_NEEDS_FC_pdflatex  :=
TL_NEEDS_FC_xelatex   := 1
TL_NEEDS_FC_lualatex  :=
TL_NEEDS_FC_bibtexu   :=
TL_NEEDS_FC_xdvipdfmx :=
TL_NEEDS_FC_makeindex :=
TL_NEEDS_FC_synctex   :=

# Per-engine: the specific target to build in texk/web2c. We avoid `make all`
# in web2c because it compiles luaharfbuzz/lualibs even for non-lua engines.
TL_WEB2C_TARGET_pdflatex := pdftex
TL_WEB2C_TARGET_xelatex  := xetex
TL_WEB2C_TARGET_lualatex := luahbtex
TL_WEB2C_TARGET_bibtexu  :=
TL_WEB2C_TARGET_xdvipdfmx:=
TL_WEB2C_TARGET_makeindex:=
TL_WEB2C_TARGET_synctex  :=

# For non-web2c engines, the binary is built by the main SUBDIRS pass; we just
# need to know where to find it for the final relink.
TL_BIN_PATH_pdflatex := texk/web2c/pdftex
TL_BIN_PATH_xelatex  := texk/web2c/xetex
TL_BIN_PATH_lualatex := texk/web2c/luahbtex
TL_BIN_PATH_bibtexu  := texk/bibtex-x/bibtexu
TL_BIN_PATH_xdvipdfmx:= texk/dvipdfm-x/xdvipdfmx
TL_BIN_PATH_makeindex:= texk/makeindexk/makeindex
TL_BIN_PATH_synctex  := texk/web2c/synctex

# Per-engine final-link specs. Objects + archives, relative to Work/.
# Used to re-link with our Emscripten flags (MODULARIZE/EXPORT_ES6/WASMFS).
TL_LINK_OBJS_pdflatex := \
	texk/web2c/pdftexdir/pdftex-pdftexextra.o \
	texk/web2c/synctexdir/pdftex-synctex.o \
	texk/web2c/pdftex-pdftexini.o \
	texk/web2c/pdftex-pdftex0.o \
	texk/web2c/pdftex-pdftex-pool.o
TL_LINK_ARCS_pdflatex := \
	texk/web2c/libpdftex.a \
	texk/web2c/libmd5.a \
	texk/web2c/lib/lib.a \
	libs/libpng/libpng.a \
	libs/zlib/libz.a \
	libs/xpdf/libxpdf.a \
	libs/pplib/libpplib.a \
	libs/zziplib/libzzip.a \
	texk/kpathsea/.libs/libkpathsea.a

# makeindex: glob *.o + libkpathsea.
TL_LINK_OBJS_makeindex := texk/makeindexk/mkind.o texk/makeindexk/genind.o texk/makeindexk/scanid.o texk/makeindexk/scanst.o texk/makeindexk/sortid.o texk/makeindexk/qsort.o
TL_LINK_ARCS_makeindex := texk/kpathsea/.libs/libkpathsea.a

# xdvipdfmx: all .o files in texk/dvipdfm-x + libkpathsea + libpng + libz + libpaper.
# The .o list mirrors TL's link line; getpass is satisfied by scripts/stubs.c.
TL_LINK_OBJS_xdvipdfmx := \
	texk/dvipdfm-x/agl.o texk/dvipdfm-x/bmpimage.o texk/dvipdfm-x/cff.o \
	texk/dvipdfm-x/cff_dict.o texk/dvipdfm-x/cid.o texk/dvipdfm-x/cidtype0.o \
	texk/dvipdfm-x/cidtype2.o texk/dvipdfm-x/cmap.o texk/dvipdfm-x/cmap_read.o \
	texk/dvipdfm-x/cmap_write.o texk/dvipdfm-x/cs_type2.o texk/dvipdfm-x/dpxconf.o \
	texk/dvipdfm-x/dpxcrypt.o texk/dvipdfm-x/dpxfile.o texk/dvipdfm-x/dpxutil.o \
	texk/dvipdfm-x/dvi.o texk/dvipdfm-x/dvipdfmx.o texk/dvipdfm-x/epdf.o \
	texk/dvipdfm-x/error.o texk/dvipdfm-x/fontmap.o texk/dvipdfm-x/jp2image.o \
	texk/dvipdfm-x/jpegimage.o texk/dvipdfm-x/mem.o texk/dvipdfm-x/mfileio.o \
	texk/dvipdfm-x/mpost.o texk/dvipdfm-x/mt19937ar.o texk/dvipdfm-x/numbers.o \
	texk/dvipdfm-x/otl_opt.o texk/dvipdfm-x/pdfcolor.o texk/dvipdfm-x/pdfdev.o \
	texk/dvipdfm-x/pdfdoc.o texk/dvipdfm-x/pdfdraw.o texk/dvipdfm-x/pdfencrypt.o \
	texk/dvipdfm-x/pdfencoding.o texk/dvipdfm-x/pdffont.o texk/dvipdfm-x/pdfnames.o \
	texk/dvipdfm-x/pdfobj.o texk/dvipdfm-x/pdfparse.o texk/dvipdfm-x/pdfresource.o \
	texk/dvipdfm-x/pdfximage.o texk/dvipdfm-x/pkfont.o texk/dvipdfm-x/pngimage.o \
	texk/dvipdfm-x/pst.o texk/dvipdfm-x/pst_obj.o texk/dvipdfm-x/sfnt.o \
	texk/dvipdfm-x/spc_color.o texk/dvipdfm-x/spc_dvipdfmx.o texk/dvipdfm-x/spc_dvips.o \
	texk/dvipdfm-x/spc_html.o texk/dvipdfm-x/spc_misc.o texk/dvipdfm-x/spc_pdfm.o \
	texk/dvipdfm-x/spc_tpic.o texk/dvipdfm-x/spc_util.o texk/dvipdfm-x/spc_xtx.o \
	texk/dvipdfm-x/specials.o texk/dvipdfm-x/subfont.o texk/dvipdfm-x/t1_char.o \
	texk/dvipdfm-x/t1_load.o texk/dvipdfm-x/tfm.o texk/dvipdfm-x/truetype.o \
	texk/dvipdfm-x/tt_aux.o texk/dvipdfm-x/tt_cmap.o texk/dvipdfm-x/tt_glyf.o \
	texk/dvipdfm-x/tt_gsub.o texk/dvipdfm-x/tt_post.o texk/dvipdfm-x/tt_table.o \
	texk/dvipdfm-x/type0.o texk/dvipdfm-x/type1.o texk/dvipdfm-x/type1c.o \
	texk/dvipdfm-x/unicode.o texk/dvipdfm-x/vf.o texk/dvipdfm-x/xbb.o
TL_LINK_ARCS_xdvipdfmx := \
	texk/kpathsea/.libs/libkpathsea.a \
	libs/libpng/libpng.a \
	libs/zlib/libz.a \
	libs/libpaper/libpaper.a

# lualatex (luahbtex): two .o + ~17 .a files.
TL_LINK_OBJS_lualatex := \
	texk/web2c/luatexdir/luahbtex-luatex.o \
	texk/web2c/mplibdir/luahbtex-lmplib.o
TL_LINK_ARCS_lualatex := \
	texk/web2c/libluahbtexspecific.a \
	texk/web2c/libluatex.a \
	texk/web2c/libff.a \
	texk/web2c/libluamisc.a \
	texk/web2c/libluasocket.a \
	texk/web2c/libluaffi.a \
	texk/web2c/libluaharfbuzz.a \
	texk/web2c/libluaharfbuzzsubset.a \
	libs/lua53/.libs/libtexlua53.a \
	texk/web2c/libmplibcore.a \
	libs/zziplib/libzzip.a \
	libs/libpng/libpng.a \
	libs/harfbuzz/libharfbuzz.a \
	libs/graphite2/libgraphite2.a \
	libs/pplib/libpplib.a \
	libs/zlib/libz.a \
	texk/web2c/lib/lib.a \
	texk/kpathsea/.libs/libkpathsea.a \
	texk/web2c/libmputil.a \
	texk/web2c/libunilib.a \
	texk/web2c/libmd5.a

# xelatex: 5 .o + ~13 archives + our wasm fontconfig/expat (built outside Work).
TL_LINK_OBJS_xelatex := \
	texk/web2c/xetexdir/xetex-xetexextra.o \
	texk/web2c/synctexdir/xetex-synctex.o \
	texk/web2c/xetex-xetexini.o \
	texk/web2c/xetex-xetex0.o \
	texk/web2c/xetex-xetex-pool.o
TL_LINK_ARCS_xelatex := \
	texk/web2c/libxetex.a \
	texk/web2c/libmd5.a \
	texk/web2c/lib/lib.a \
	libs/harfbuzz/libharfbuzz.a \
	libs/graphite2/libgraphite2.a \
	libs/icu/icu-build/lib/libicuuc.a \
	libs/icu/icu-build/lib/libicudata.a \
	libs/teckit/libTECkit.a \
	libs/libpng/libpng.a \
	libs/freetype2/libfreetype.a \
	libs/pplib/libpplib.a \
	libs/zlib/libz.a \
	texk/kpathsea/.libs/libkpathsea.a

# Absolute-path extras (wasm-libs/, not Work-relative).
TL_LINK_EXTRA_xelatex := $(FONTCONFIG_LIB) $(EXPAT_LIB)

# bibtexu: 6 .o + kpathsea + ICU libs.
TL_LINK_OBJS_bibtexu := \
	texk/bibtex-x/bibtexu-bibtex-1.o \
	texk/bibtex-x/bibtexu-bibtex-2.o \
	texk/bibtex-x/bibtexu-bibtex-3.o \
	texk/bibtex-x/bibtexu-bibtex-4.o \
	texk/bibtex-x/bibtexu-bibtex.o \
	texk/bibtex-x/bibtexu-utils.o
TL_LINK_ARCS_bibtexu := \
	texk/kpathsea/.libs/libkpathsea.a \
	libs/icu/icu-build/lib/libicuio.a \
	libs/icu/icu-build/lib/libicui18n.a \
	libs/icu/icu-build/lib/libicuuc.a \
	libs/icu/icu-build/lib/libicudata.a

TL_LINK_OBJS_synctex   :=
TL_LINK_ARCS_synctex   :=
TL_LINK_EXTRA_pdflatex :=
TL_LINK_EXTRA_lualatex :=
TL_LINK_EXTRA_makeindex:=
TL_LINK_EXTRA_xdvipdfmx:=
TL_LINK_EXTRA_bibtexu  :=
TL_LINK_EXTRA_synctex  :=

# Per-engine: which web2c *_DEPEND vars to leave intact. Anything not in this
# list gets blanked via sed after configure, so its hardcoded "rebuild lib X"
# rule in web2c/Makefile never fires.
TL_KEEP_DEPENDS_pdflatex := KPATHSEA LIBPNG ZLIB XPDF PPLIB ZZIPLIB PTEXENC
TL_KEEP_DEPENDS_xelatex  := KPATHSEA LIBPNG ZLIB XPDF PPLIB ZZIPLIB PTEXENC FREETYPE2 HARFBUZZ GRAPHITE2 TECKIT ICU
TL_KEEP_DEPENDS_lualatex := KPATHSEA LIBPNG ZLIB XPDF PPLIB ZZIPLIB PTEXENC FREETYPE2 HARFBUZZ LUA53
TL_KEEP_DEPENDS_bibtexu  := KPATHSEA ICU
TL_KEEP_DEPENDS_xdvipdfmx:= KPATHSEA LIBPNG ZLIB FREETYPE2
TL_KEEP_DEPENDS_makeindex:= KPATHSEA
TL_KEEP_DEPENDS_synctex  := KPATHSEA ZLIB

# All possible web2c _DEPEND vars. We blank any that aren't in the per-engine
# keep list.
TL_ALL_DEPENDS := \
	KPATHSEA PTEXENC LIBPNG ZLIB XPDF PPLIB ZZIPLIB \
	LUAJIT LUA53 LUA \
	FREETYPE2 HARFBUZZ GRAPHITE2 TECKIT ICU \
	CAIRO PIXMAN GMP MPFI MPFR POTRACE

# Common configure options. We disable everything we don't need and rely on
# the engine-specific --enable-* to opt back in to deps.
#
# --build is mandatory for autoconf cross-compile mode; we hardcode x86_64
# since the Docker image is x86_64.
TL_CONFIGURE_COMMON := \
	--host=wasm32-unknown-emscripten \
	--build=x86_64-pc-linux-gnu \
	--disable-shared \
	--disable-largefile \
	--disable-all-pkgs \
	--enable-web2c \
	--disable-luajittex \
	--disable-luajithbtex \
	--disable-aleph \
	--disable-xetex \
	--enable-omfonts=no \
	--without-x \
	--without-iconv

# Per-engine recipe template.
#
#   $(1) — engine id (pdflatex, xelatex, ...)
#
# The `configure` step writes a Work/ tree under build/<engine>/emscripten/Work.
# We don't `make install`; we cherry-pick the engine binary the link step
# needs.
define ENGINE_TEMPLATE_em
.PHONY: $(1)-emscripten
$(1)-emscripten: $$(BUILD_DIR)/$(1)/emscripten/$(1).wasm

$$(BUILD_DIR)/$(1)/emscripten/$(1).wasm: $$(NATIVE_DONE) $$(if $$(TL_NEEDS_ICU_$(1)),$$(ICU_NATIVE_DONE)) $$(if $$(TL_NEEDS_FC_$(1)),$$(WASM_LIBS_DONE)) $$(EM_LINK_DEPS) | source
	@if [ -z "$$(TL_CONFIGURE_FLAG_$(1))" ]; then \
	  echo "==> [emscripten] $(1) — no configure flag wired yet; nothing built"; \
	  exit 0; \
	fi; \
	echo "==> [emscripten] $(1) — configure (wrapped CC, native helpers preloaded)"; \
	mkdir -p $$(BUILD_DIR)/$(1)/emscripten/Work; \
	set -e; \
	WRAPPER="python3 $$(ROOT)/scripts/emcc_wrapper.py $$(NATIVE_HELPER_PATHS) --"; \
	HELPER_PATH="$$(NATIVE_BUILD)/Work/texk/web2c:$$(NATIVE_BUILD)/Work/texk/web2c/web2c"; \
	echo "==> [emscripten] $(1) — pre-compiling stubs.o"; \
	source /opt/emsdk/emsdk_env.sh >/dev/null 2>&1 && \
	  emcc -Oz -c $$(ROOT)/scripts/stubs.c -o $$(BUILD_DIR)/$(1)/emscripten/stubs.o 2>/dev/null; \
	STUBS_O=$$(BUILD_DIR)/$(1)/emscripten/stubs.o; \
	cd $$(BUILD_DIR)/$(1)/emscripten/Work && \
	  source /opt/emsdk/emsdk_env.sh >/dev/null 2>&1 && \
	  export PATH="$$$$HELPER_PATH:$$$$PATH" && \
	  emconfigure $$(TL_SOURCE)/configure \
	    $$(TL_CONFIGURE_COMMON) \
	    $$(TL_CONFIGURE_FLAG_$(1)) \
	    CC="$$$$WRAPPER emcc" CXX="$$$$WRAPPER em++" \
	    CFLAGS="$$(OPT) $$(THREAD_CFLAGS) -D_GNU_SOURCE -Wno-error=implicit-function-declaration -Wno-error=int-conversion -include $$(ROOT)/scripts/stubs_force.h $$(if $$(TL_NEEDS_FC_$(1)),-I$$(FONTCONFIG_SRC) -I$$(FONTCONFIG_BUILD) -I$$(FREETYPE_INCLUDE) -I$$(EXPAT_INCLUDE))" \
	    CXXFLAGS="$$(OPT) $$(THREAD_CFLAGS) -D_GNU_SOURCE -Wno-error=implicit-function-declaration -Wno-error=int-conversion -include $$(ROOT)/scripts/stubs_force.h $$(if $$(TL_NEEDS_FC_$(1)),-I$$(FONTCONFIG_SRC) -I$$(FONTCONFIG_BUILD) -I$$(FREETYPE_INCLUDE) -I$$(EXPAT_INCLUDE))" \
	    $$(if $$(TL_NEEDS_FC_$(1)),FONTCONFIG_CFLAGS="-I$$(FONTCONFIG_SRC) -I$$(FONTCONFIG_BUILD)" FONTCONFIG_LIBS="$$(FONTCONFIG_LIB) $$(EXPAT_LIB)") \
	    > configure.log 2>&1 \
	  || (echo "==> [emscripten] $(1) — configure FAILED. Tail of configure.log:"; \
	      tail -60 configure.log; \
	      echo "=== Last config.log error (if any) ==="; \
	      find . -name config.log -exec grep -l 'error:\|configure: error' {} \; \
	        | xargs -I{} sh -c 'echo "--- {} ---"; grep -B2 -A1 -E "error:|configure: error" {} | tail -30'; \
	      exit 1); \
	echo "==> [emscripten] $(1) — configure OK"; \
	echo "==> [emscripten] $(1) — trimming SUBDIRS (libs='$$(TL_LIBS_$(1))', texk='$$(TL_TEXK_$(1))')"; \
	sed -i 's|^MAKE_SUBDIRS = .*|MAKE_SUBDIRS = $$(TL_LIBS_$(1))|' \
	  $$(BUILD_DIR)/$(1)/emscripten/Work/libs/Makefile; \
	sed -i 's|^MAKE_SUBDIRS = .*|MAKE_SUBDIRS = $$(TL_TEXK_$(1))|' \
	  $$(BUILD_DIR)/$(1)/emscripten/Work/texk/Makefile; \
	echo "==> [emscripten] $(1) — blanking unused web2c _DEPEND vars"; \
	for dep in $$(TL_ALL_DEPENDS); do \
	  case " $$(TL_KEEP_DEPENDS_$(1)) " in *" $$$$dep "*) continue ;; esac; \
	  sed -i "s|^$$$${dep}_DEPEND = .*|$$$${dep}_DEPEND =|" \
	    $$(BUILD_DIR)/$(1)/emscripten/Work/texk/web2c/Makefile 2>/dev/null || true; \
	done; \
	if [ -n "$$(TL_NEEDS_ICU_$(1))" ]; then \
	  echo "==> [emscripten] $(1) — symlinking pre-built native ICU"; \
	  mkdir -p $$(BUILD_DIR)/$(1)/emscripten/Work/libs/icu; \
	  rm -rf $$(BUILD_DIR)/$(1)/emscripten/Work/libs/icu/icu-native; \
	  ln -snf $$(ICU_NATIVE_DIR) \
	    $$(BUILD_DIR)/$(1)/emscripten/Work/libs/icu/icu-native; \
	fi; \
	: "TL configures its subdirectories during make, not during configure, so" \
	  "Work/libs/icu does not exist yet on a clean tree — mkdir it above rather" \
	  "than testing for it. The symlink must be in place BEFORE the make below:" \
	  "TL's libs/icu Makefile has an 'icu-native/Makefile:' rule that configures" \
	  "and builds a HOST icu with the cross compiler, which dies with" \
	  "'cannot run C compiled programs' (autoconf error 77). Pointing icu-native" \
	  "at the real native build (it already has a Makefile) satisfies that rule" \
	  "and skips it. Guarding this on the directory's existence meant the ICU" \
	  "engines only built on a SECOND make, i.e. never in clean-room CI."; \
	if [ -f $$(BUILD_DIR)/$(1)/emscripten/Work/libs/icu/Makefile ]; then \
	  echo "==> [emscripten] $(1) — patching libs/icu Makefile (force native gcc + --without-assembly)"; \
	  $$(ROOT)/scripts/patch-icu-makefile.sh \
	    $$(BUILD_DIR)/$(1)/emscripten/Work/libs/icu/Makefile; \
	fi; \
	echo "==> [emscripten] $(1) — make (top-level libs+texk, then web2c/$$(TL_WEB2C_TARGET_$(1)))"; \
	cd $$(BUILD_DIR)/$(1)/emscripten/Work && \
	  source /opt/emsdk/emsdk_env.sh >/dev/null 2>&1 && \
	  export PATH="$$$$HELPER_PATH:$$$$PATH" && \
	  export PKGDATA_OPTS="--without-assembly -O $$(BUILD_DIR)/$(1)/emscripten/Work/libs/icu/icu-native/data/icupkg.inc" && \
	  ( \
	    emmake $$(MAKE) -j$$(shell nproc 2>/dev/null || echo 2) > make.log 2>&1; \
	    LIB_RC=$$$$?; \
	    if [ "$$$$LIB_RC" -ne 0 ] && [ -z "$$$$(find libs texk/kpathsea -name '*.a' -type f 2>/dev/null | head -1)" ]; then \
	      echo "==> [emscripten] $(1) — top-level make produced no static libs; aborting"; \
	      tail -60 make.log; exit 1; \
	    fi; \
	    if [ -n "$$(TL_NEEDS_ICU_$(1))" ] && [ -f texk/web2c/Makefile ]; then \
	      echo "==> [emscripten] $(1) — injecting stubs.o into engine LDADD lines (post-make)"; \
	      STUBS_O_ABS=$$(BUILD_DIR)/$(1)/emscripten/stubs.o; \
	      for engine_name in xetex luatex luahbtex bibtexu; do \
	        sed -i "s|^$$$${engine_name}_LDADD = .*$$$$|& $$$$STUBS_O_ABS|" \
	          texk/web2c/Makefile 2>/dev/null || true; \
	      done; \
	      if [ -f texk/bibtex-x/Makefile ]; then \
	        sed -i "s|^bibtexu_LDADD = .*$$$$|& $$$$STUBS_O_ABS|" \
	          texk/bibtex-x/Makefile 2>/dev/null || true; \
	      fi; \
	    fi; \
	    if [ -n "$$(TL_WEB2C_TARGET_$(1))" ] && [ -f texk/web2c/Makefile ]; then \
	      emmake $$(MAKE) -C texk/web2c -j$$(shell nproc 2>/dev/null || echo 2) $$(TL_WEB2C_TARGET_$(1)) >> make.log 2>&1 || \
	        echo "==> [emscripten] $(1) — TL inner web2c link failed (ok, we re-link with our flags below)"; \
	    fi; \
	    true \
	  ) \
	  || (echo "==> [emscripten] $(1) — make wrapper FAILED. Tail of make.log:"; \
	      tail -60 make.log; exit 1); \
	echo "==> [emscripten] $(1) — final link / stage"; \
	WORK=$$(BUILD_DIR)/$(1)/emscripten/Work; \
	OUT_DIR=$$(BUILD_DIR)/$(1)/emscripten; \
	OBJS=""; \
	for o in $$(TL_LINK_OBJS_$(1)); do \
	  [ -f $$$$WORK/$$$$o ] && OBJS="$$$$OBJS $$$$WORK/$$$$o"; \
	done; \
	ARCS=""; \
	for a in $$(TL_LINK_ARCS_$(1)); do \
	  [ -f $$$$WORK/$$$$a ] && ARCS="$$$$ARCS $$$$WORK/$$$$a"; \
	done; \
	if [ -n "$$$$OBJS" ]; then \
	  echo "==> [emscripten] $(1) — re-linking with our flags"; \
	  source /opt/emsdk/emsdk_env.sh >/dev/null 2>&1 && \
	  STUBS_O=$$$$OUT_DIR/stubs.o && \
	  emcc -Oz -c $$(ROOT)/scripts/stubs.c -o $$$$STUBS_O 2>/dev/null && \
	  LAZY_O=$$$$OUT_DIR/wasmfs-lazy.o && \
	  emcc -Oz -c $$(ROOT)/scripts/wasmfs-lazy.c -o $$$$LAZY_O && \
	  em++ $$(EMCC_COMMON) --js-library $$(ROOT)/scripts/wasmfs-lazy-lib.js \
	    -o $$$$OUT_DIR/$(1).js $$$$OBJS $$$$STUBS_O $$$$LAZY_O $$$$ARCS $$(TL_LINK_EXTRA_$(1)) \
	    > $$$$OUT_DIR/link.log 2>&1 \
	  || (echo "==> [emscripten] $(1) — link FAILED:"; tail -30 $$$$OUT_DIR/link.log; exit 1); \
	else \
	  echo "==> [emscripten] $(1) — no link spec, staging TL artifact"; \
	  BIN=$$$$WORK/$$(TL_BIN_PATH_$(1)); \
	  if [ ! -f $$$$BIN ]; then \
	    echo "==> [emscripten] $(1) — TL artifact missing at $$$$BIN. Search:"; \
	    find $$$$WORK -maxdepth 5 -name '*.wasm' -size +50k 2>/dev/null | head -5; \
	    exit 1; \
	  fi; \
	  cp $$$$BIN $$$$OUT_DIR/$(1).js; \
	  [ -f $$$$BIN.wasm ] && cp $$$$BIN.wasm $$@ || cp $$$$BIN $$@; \
	fi; \
	if [ ! -s $$@ ]; then \
	  echo "==> [emscripten] $(1) — FAILED: the link left no $(1).wasm behind (see $$$$OUT_DIR/link.log)"; \
	  exit 1; \
	fi; \
	if [ "$$$$(od -An -tx1 -N4 $$@ | tr -d ' \n')" != "0061736d" ]; then \
	  echo "==> [emscripten] $(1) — FAILED: $(1).wasm carries no wasm magic (JS glue copied over it?)"; \
	  exit 1; \
	fi; \
	echo "==> [emscripten] $(1) — DONE"; \
	ls -la $$$$OUT_DIR/
endef

$(foreach e,$(ENGINES_V1),$(eval $(call ENGINE_TEMPLATE_em,$(e))))

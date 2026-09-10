#pragma once

// Portability shim: builds TopoConv with MSVC or with GCC/Clang on Linux.
//
// TopoConv never called a Windows API. What tied it to MSVC was dialect --
// the annex-K `_s` functions, the `_i64` stdio variants, MSVC byteswap
// intrinsics, and <ddraw.h> for two type names. This header supplies all of
// it so the .cpp files stay as close to the originals as possible.

#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <float.h>

// ---------------------------------------------------------------------------
// DDS header types, formerly from <ddraw.h>
// ---------------------------------------------------------------------------
//
// <ddraw.h> was included for exactly two names: DWORD and DDPIXELFORMAT.
// DirectDraw's DDPIXELFORMAT is eight DWORDs -- its five unions are all
// DWORD-wide -- which is the DDS_PIXELFORMAT of the DDS spec. Declaring it
// here drops the DirectX SDK dependency from the Windows build too, and with
// it <windows.h>'s min/max macros.
//
// These structs are fwrite'd raw and their sizeof() goes into dwSize, so the
// layout is load-bearing. The static_asserts below are not decoration; the
// values are the ones the shipped 4096 EarthHeight.dds actually carries
// (dwSize 124, pf.dwSize 32, flags 0x100f, DDPF_LUMINANCE, DDSCAPS_TEXTURE).

typedef uint32_t DWORD;

typedef struct {
    DWORD dwSize;
    DWORD dwFlags;
    DWORD dwFourCC;
    DWORD dwRGBBitCount;
    DWORD dwRBitMask;
    DWORD dwGBitMask;
    DWORD dwBBitMask;
    DWORD dwRGBAlphaBitMask;
} DDPIXELFORMAT;

static_assert(sizeof(DDPIXELFORMAT) == 32, "DDS pixel format must be 32 bytes");

#define DDSD_CAPS        0x00000001u
#define DDSD_HEIGHT      0x00000002u
#define DDSD_WIDTH       0x00000004u
#define DDSD_PITCH       0x00000008u
#define DDSD_PIXELFORMAT 0x00001000u
#define DDSD_MIPMAPCOUNT 0x00020000u
#define DDSD_LINEARSIZE  0x00080000u

#define DDPF_ALPHAPIXELS 0x00000001u
#define DDPF_RGB         0x00000040u
#define DDPF_LUMINANCE   0x00020000u

#define DDSCAPS_TEXTURE  0x00001000u

// MAX_PATH reached TopoConv.cpp through <ddraw.h> -> <windows.h>, so dropping
// that include takes it away on MSVC too, not just on Linux. Same value
// <minwindef.h> uses; the guard keeps it compatible if <windows.h> arrives by
// some other route later.
#ifndef MAX_PATH
#define MAX_PATH 260
#endif

// ---------------------------------------------------------------------------
// min / max
// ---------------------------------------------------------------------------
//
// <windows.h> defined these as function-like macros, so call sites relied on
// macro behaviour: mixed argument types were fine, resolved by the ternary's
// usual arithmetic conversions. Three sites depend on that -- uint16_t
// against uint32_t in FixPoles, and float against double in the autoscale
// scan -- so std::min/std::max cannot be dropped in, they would fail to
// deduce a single T.
//
// Macros are not an option either: libstdc++ does not guard its headers
// against them the way MSVC's STL does. These overloads take mixed types and
// return std::common_type, which for arithmetic types is by definition the
// result of the usual arithmetic conversions -- the same type the macro's
// ternary produced. So they are value-equivalent at every call site, with no
// macro hazard.
//
// Note the return type is common_type and NOT decltype(a > b ? a : b): that
// ternary is an lvalue when both operands are, so decltype would deduce T&
// and hand back a reference to a by-value parameter. GCC's -Wdangling-pointer
// caught exactly that on the first build of this port.

#include <type_traits>

template<typename A, typename B>
inline typename std::common_type<A, B>::type max(A a, B b) { return a > b ? a : b; }

template<typename A, typename B>
inline typename std::common_type<A, B>::type min(A a, B b) { return a < b ? a : b; }

// ---------------------------------------------------------------------------
// MSVC dialect
// ---------------------------------------------------------------------------

#ifdef _MSC_VER

#include <io.h>
#include <malloc.h>

#else // GCC / Clang

#include <alloca.h>
#include <errno.h>
#include <strings.h>
#include <unistd.h>
#include <sys/stat.h>
#include <limits.h>

inline int fopen_s(FILE** f, const char* name, const char* mode)
{
    *f = fopen(name, mode);
    if (*f)
        return 0;
    return errno ? errno : -1;
}

inline int _stricmp(const char* a, const char* b) { return strcasecmp(a, b); }

// The Windows build got the buffer size from MSVC's array-reference template
// overload. Same trick, so call sites keep passing a bare array.
template<size_t N, typename... Args>
inline int sprintf_s(char (&buf)[N], const char* fmt, Args... args)
{
    return snprintf(buf, N, fmt, args...);
}

inline int strcpy_s(char* dst, size_t size, const char* src)
{
    if (!dst || !src || size == 0)
        return EINVAL;
    if (strlen(src) >= size)
    {
        dst[0] = '\0';
        return ERANGE;
    }
    strcpy(dst, src);
    return 0;
}

// 64-bit stdio. off_t is already 64-bit on LP64 Linux, which matters here:
// topo30.raw is 1.74 GiB, so a 32-bit offset would wrap.
inline int _fseeki64(FILE* fp, int64_t offset, int origin)
{
    return fseeko(fp, (off_t)offset, origin);
}

inline int64_t _ftelli64(FILE* fp) { return (int64_t)ftello(fp); }

inline int _fileno_compat(FILE* fp) { return fileno(fp); }
#define _fileno(fp) _fileno_compat(fp)

inline int64_t _filelengthi64(int fd)
{
    struct stat st;
    if (fstat(fd, &st) != 0)
        return -1;
    return (int64_t)st.st_size;
}

inline uint32_t _byteswap_ulong(uint32_t x) { return __builtin_bswap32(x); }
inline uint16_t _byteswap_ushort(uint16_t x) { return __builtin_bswap16(x); }

#endif // _MSC_VER

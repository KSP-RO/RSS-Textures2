# TopoConv, Linux/macOS build.  make -> bin/TopoConv
#
# -ffp-contract=off is not optional. GCC defaults to `fast`, which fuses
# a*b+c into a single FMA and changes the low bits of the bilinear and mean
# resampling paths. This build is meant to reproduce bin/TopoConv.exe bit for
# bit, and MSVC does not contract by default.
#
# No -march, no -ffast-math, no -Ofast, for the same reason: the output has to
# be identical on every machine that builds this, not merely fast. Output that
# moves is terrain that moves.

CXX      ?= g++
CXXFLAGS ?= -O2 -std=c++17 -fopenmp -ffp-contract=off -Wall -Wno-unused-result
LDFLAGS  ?= -fopenmp

SRC := TopoConv.cpp ReadTiff.cpp
OBJ := $(SRC:.cpp=.o)
BIN := bin/TopoConv

all: $(BIN)

$(BIN): $(OBJ)
	@mkdir -p bin
	$(CXX) $(OBJ) -o $@ $(LDFLAGS)

%.o: %.cpp compat.h ReadTiff.h
	$(CXX) $(CXXFLAGS) -c $< -o $@

clean:
	rm -f $(OBJ) $(BIN)

.PHONY: all clean

# Build environment for the engine. The repository is mounted at
# /work/inceptionjs; everything generated lives in its .work directory,
# including the compiler cache, so a disk snapshot keeps it all.
FROM debian:trixie
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake ninja-build pkg-config git curl ca-certificates \
      tar xz-utils unzip python3 nodejs npm perl ruby gperf bison flex \
      autotools-dev automake libtool ccache \
      fonts-dejavu-core fonts-dejavu-extra fonts-noto-color-emoji fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
ENV EM_COMPILER_WRAPPER=ccache \
    CCACHE_DIR=/work/inceptionjs/.work/ccache \
    CCACHE_BASEDIR=/work/inceptionjs \
    CCACHE_MAXSIZE=30G \
    CCACHE_SLOPPINESS=include_file_mtime,time_macros,pch_defines
WORKDIR /work/inceptionjs

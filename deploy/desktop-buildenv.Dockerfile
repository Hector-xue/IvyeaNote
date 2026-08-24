# Ivyea Note 桌面端 Linux 构建环境
# 用途：CentOS Stream 9 仓库缺 webkit2gtk-4.1，改在 Debian 容器内 cargo check / build。
# 构建：docker build -t ivnote-desktop-buildenv -f desktop-buildenv.Dockerfile .
# 使用：docker run --rm -v "$(pwd)/../desktop/src-tauri":/work -w /work \
#         ivnote-desktop-buildenv cargo check
FROM debian:bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        curl \
        ca-certificates \
        pkg-config \
        file \
        libwebkit2gtk-4.1-dev \
        libgtk-3-dev \
        libayatana-appindicator3-dev \
        librsvg2-dev \
        libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Rust 工具链（minimal profile，够 cargo check/build 用）
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable

WORKDIR /work
CMD ["cargo", "check"]

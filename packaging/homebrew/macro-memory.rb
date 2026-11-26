# Homebrew formula：装的是单文件二进制，不拖 Node。
#
# 这份文件由 `node tools/gen-formula.mjs --apply --sums <目录>` 生成，
# 手改只改 desc / caveats 这类文案——版本号与四个 sha256 是灌进来的。
#
# 为什么走单文件而不是 `depends_on "node"` + npm 包：
#   - 装了 Node 也不代表有 node:sqlite（22.5 才有，我们的 engines 写 24），
#     在 formula 里判宿主版本、判失败再让人装 node，比直接不发 Node 依赖麻烦得多；
#   - 单文件产物是 mac/linux 各一份、体积 92 MB，brew 的缓存与升级路径天然适合；
#   - 用户 `brew install` 完就能 `macro-memory mcp`，机器上不必先有 Node。
#
# 占位符 __SHA256_…__ 只会在「那个平台的产物还没打出来」时留着；
# gen-formula 读到 SHA256SUMS 里有的平台就替换，读不到就保留占位并在报告里点名。
class MacroMemory < Formula
  desc "Local memory layer for any agent — one library, every host"
  homepage "https://github.com/hanhan9999999999999999999/dsh-macro-memory"
  version "0.9.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/hanhan9999999999999999999/dsh-macro-memory/releases/download/v#{version}/macro-memory-mac-arm64"
      sha256 "__SHA256_MAC_ARM64__"
    end

    on_intel do
      url "https://github.com/hanhan9999999999999999999/dsh-macro-memory/releases/download/v#{version}/macro-memory-mac-x64"
      sha256 "__SHA256_MAC_X64__"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/hanhan9999999999999999999/dsh-macro-memory/releases/download/v#{version}/macro-memory-linux-arm64"
      sha256 "__SHA256_LINUX_ARM64__"
    end

    on_intel do
      url "https://github.com/hanhan9999999999999999999/dsh-macro-memory/releases/download/v#{version}/macro-memory-linux-x64"
      sha256 "__SHA256_LINUX_X64__"
    end
  end

  def install
    # 每个平台的产物名只差最后那截，取到哪个装哪个。
    binary = Dir["macro-memory-*"].reject { |f| f.end_with?(".zip") }.first
    odie "这个平台没有匹配的产物（包里只有：#{(Dir['*']).join(', ')}）" if binary.nil?
    bin.install binary => "macro-memory"
  end

  def caveats
    <<~EOS
      接进宿主（任选一个）：

        Codex / Claude Code / Cursor 的 MCP 配置里加：
          "command": "macro-memory", "args": ["mcp"]

      DSH 里装插件（这条不用 brew）：
          npx -y dsh-macro-memory

      库默认落在数据目录，与 DSH 插件共用同一份：
          macro-memory doctor     # 看一眼版本、库位置、信任状态
    EOS
  end

  test do
    # brew audit 要求 formula 能自测；这两条也是用户拿到手最先敲的两条。
    assert_match version.to_s, shell_output("#{bin}/macro-memory --version")
    assert_match "mcp", shell_output("#{bin}/macro-memory --help")
  end
end

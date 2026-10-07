# agent-stack

Один установщик для **rtk + bili (billion-context) + headroom + caveman** для Claude Code, Codex, OpenCode, DeepSeek Harness. macOS и Windows.

## Установка

```bash
# macOS
./install.sh            # или: curl -fsSL https://raw.githubusercontent.com/flywalk4/agent-stack/main/install.sh | bash
```

```powershell
# Windows (PowerShell 5.1+)
.\install.ps1           # или: irm https://raw.githubusercontent.com/flywalk4/agent-stack/main/install.ps1 | iex
```

Bootstrap ставит node / uv (brew / winget), затем запускает интерактивный `agent-stack install`: выбор агентов и слоёв, план, подтверждение.

```
agent-stack install [--yes]   интерактивно (--yes = всё найденное, без вопросов)
agent-stack doctor [--json]   сервисы, конфиги, e2e-пробы цепочек
agent-stack dashboard         общий дашборд http://127.0.0.1:18800
agent-stack uninstall         снять сервисы, вернуть конфиги из бэкапов
```

## Связи

| Агент | Цепочка |
|---|---|
| Claude Code | rtk → bili `:18788` → headroom `:8787` → api.anthropic.com |
| Codex | rtk → bili `:18788` → headroom `:8787` → chatgpt.com / api.openai.com (HTTP, без WS) |
| OpenCode | rtk → bili-native (in-process) → headroom transport plugin → `:8787` → провайдер |
| DeepSeek Harness | rtk → bili-native (dsh bundle) → headroom `:8788` → api.deepseek.com |

Почему так:
- **bili перед headroom**: bili держит стабильный префикс (prompt cache), headroom в режиме `cache` сжимает только дельту и префикс не ломает.
- **rtk и caveman** работают внутри агента (хуки, правила, скиллы), в сетевую цепочку не встают. Лаунчер/прокси caveman (`caveman claude`) не ставим, иначе появится четвёртый сетевой хоп.
- **Codex без WebSocket**: на WS bili и headroom оба переписывают `previous_response_id`, и Codex ловит `previous_response_not_found`.
- **Отдельный headroom для DeepSeek** (`--openai-api-url https://api.deepseek.com`): чтобы OpenAI-трафик Codex не ушёл в DeepSeek.

## Сервисы

- macOS: launchd user agents `dev.agent-stack.*` в `~/Library/LaunchAgents`, логи в `~/Library/Logs/agent-stack/`.
- Windows: Task Scheduler `agent-stack-*`, запуск при входе, скрытое окно, автоперезапуск. Логи в `%USERPROFILE%\.agent-stack\logs`.

Все изменённые конфиги бэкапятся один раз (состояние до agent-stack) в `~/.agent-stack/backups`, `uninstall` их возвращает.

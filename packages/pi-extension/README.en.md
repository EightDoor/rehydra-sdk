# pi-rehydra

Scrub detected secrets from Pi conversations before the main LLM request.

[中文](./README.md)

This extension intercepts the conversation between [Pi](https://pi.dev) and the LLM. Secrets from your `.env` files are replaced with placeholders before they leave your machine, and transparently restored before any tool (shell commands, file writes, etc.) executes locally; a placeholder that cannot be restored blocks that tool call.

It uses Pi's `ExtensionAPI` events: `context_with_system`, `tool_call`, `tool_result`, `message_end`, and `session_start` / `session_shutdown`.

Detection and rehydration are local. The model only sees placeholders; your tools always see real values.

## Install

```bash
pi install npm:pi-rehydra
```

Pi writes the package entry to `~/.pi/agent/settings.json`. Edit that file to add extension options:

```json
{
  "packages": [
    {
      "source": "npm:pi-rehydra"
    }
  ],
  "rehydra": {
    "envFiles": [".env", ".env.local"],
    "redactValues": ["sk-live-abc123..."],
    "allowLiteralTagsIn": ["write", "edit"]
  }
}
```

Every key under `rehydra` is an extension option: `envFiles`, `redactValues`, `minValueLength`, `disableTypes`, `locale`, `vcsIdentities`, `policy`, `anonymizer`, `tagFormat`. `envFiles` defaults to `["**/.env*"]`, skipping `node_modules`, `.git`, and symlinks.

`allowLiteralTagsIn` defaults to an empty array (always block). Tools listed here — typically `write` and `edit` — keep an **unresolvable** literal tag in their arguments instead of aborting, so you can write documentation or tests that intentionally show tag examples. Every allowed occurrence is logged (`allowed literal tag in tool args`, tool name and argument path only). Resolvable tags are still restored in every tool.

## How it works

| Event | Effect |
|---|---|
| `session_start` | Instantiate the anonymizer, build the session map, parse the `rehydra` config, start the local viewer |
| `context_with_system` | Anonymize all request messages and inject the rehydra instruction when needed |
| `tool_call` | Strictly restore PII tags in tool arguments before local execution; an unresolvable tag blocks the call |
| `tool_result` | Anonymize the completed tool result before it re-enters model context |
| `message_end` | Rewrite the final assistant message so PII tags are replaced with real values |
| `session_shutdown` | Close the viewer, dispose of the anonymizer and session registry |

Masked message roles: `user`, `assistant`, `toolResult`, `system` (its `content` and prompt sections, except the tool declarations section), `bashExecution` (command and output), `custom`, `branchSummary`, and `compactionSummary` — exactly the roles Pi turns into model input. When the current request replaced anything, the placeholder guidance is injected as its own prompt section, so the model treats placeholders as opaque pass-through values.

On failure: an uninitialized extension blocks tool execution. A single masking failure does not abort the request — Pi swallows handler errors and sends the unmasked content anyway, so the extension catches them and logs a warning carrying only the event name and reason, never the content.

## Masking records and the local viewer

Once enabled, you can check request by request what was intercepted and what the model actually received:

```json
{
  "rehydra": {
    "record": {
      "enabled": true,
      "includeOriginal": true
    }
  }
}
```

The address is printed at startup (for example `http://127.0.0.1:53211/`) — open it directly. The record list is on the left (session / source / type / status filters, paging) and the selected record on the right, with the first record already open; content panes support wrapping, find and copy. Context and tool-result records show what the extension received next to what it handed back, plus hit details, field-level comparisons and whether that masking was reliable (ok / rules-only / failed / blocked). Clearing the current session or everything happens on the page and needs a second confirmation.

Records live in `~/.pi/agent/rehydra/records/records.sqlite` (directory 0700 and database 0600 on macOS/Linux; on Windows mode bits are not enforced and protection comes from the user profile's NTFS ACLs), kept for at most 7 days under a 300 MiB cap (whichever comes first, trimming the oldest records), with a 4 MiB per-record snapshot cap. **Original text is stored by default, so real values are written to local disk in clear text**; turn original capture off and the page still works (only the type, detector, placeholder, length and offsets are kept):

```json
{
  "rehydra": {
    "record": { "includeOriginal": false },
    "dashboard": { "enabled": false }
  }
}
```

`dashboard.enabled: false` disables the viewer. The page has no login: cross-site reads are blocked by browser same-origin rules, but other local processes can still read the records. Besides the extension's input and output, the extension records the provider-shaped request body as a separate `provider_request` record (scope `provider-payload`) using the host's `before_provider_request` hook; the page labels it as captured before sending. It only observes and never rewrites the payload, later extensions may still change the request, and it is not a packet capture. This capture follows `record.enabled` and `includeOriginal`; with original capture off no request body is written.

Any recording failure (unwritable directory, symlink, SQLite unavailable) only produces a warning and never affects masking or the request; the number of records that failed to persist is shown in the page's status area.

## Limitations
- Tool-argument rehydration is strict: when a tag is absent from this session's map (or the map is missing, or decryption fails), the tool call is blocked rather than run with `<PII .../>` as a real value. A placeholder can only be restored from the same session's map; the default map is in memory, so tags from before a process restart cannot be restored.

- Session maps are cached in-process to avoid repeated decryption. The cache is shared per storage instance and session id, so every session instance on the same storage sees the same map, and a streaming save invalidates it. Only another process, or a different storage instance over the same underlying data, can write a map this process's cache will not notice.
- Model calls that bypass these hooks (rare, e.g. user-initiated notes) are not intercepted.
- `URL`, `IP_ADDRESS`, `BIC_SWIFT`, `POSTAL_CODE` and `DATE` are disabled by default: recognizers that fire on shape alone misfire badly in code and documents. Restore them with `disableTypes: ["URL", "IP_ADDRESS"]`; a bank identifier still needs a full banking context word nearby.
- Only the values of sensitive fields in an `.env` file enter the global known-value set; project names and ports are not replaced later in the text. Explicitly configured `redactValues` are not affected by that filter.
- Collection fields in `policy` may be arrays and thresholds plain objects; an invalid field type fails startup with the field name instead of silently dropping the protection rule.
- This extension cannot guarantee that title or compaction summaries stay sanitized — disable title agents if you need titles to be human-readable.

- The viewer has no login: cross-site reads are blocked by browser same-origin rules, but other local processes can read the record database directly. With original capture on, real values stay on local disk in clear text.
- Disk usage is capped by actual file size: after trimming, free pages are returned with incremental vacuum (`PRAGMA incremental_vacuum`) instead of a full `VACUUM`. A database created by an older version is converted once on first open (that one conversion is a full `VACUUM`, a few seconds on a large file; on failure it only logs a warning and falls back to full reclamation). When several processes open the same record database, a checkpoint can return `busy` because of an open read transaction; capacity trimming is then postponed to the next write (no records are deleted to make room) and no warning is logged. Expired-record cleanup is unaffected: it runs before capacity trimming and is not rolled back, and its freed pages are returned on the next reclamation.

## License

MIT
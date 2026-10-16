@echo off
rem OBA interactive director MCP server (stdio transport).
rem Requires the OBA app to be running: it writes the endpoint info to
rem   %APPDATA%\OBA-Codex\director-api.json
rem The server itself keeps no state; it only forwards to the local HTTP API.
node "%~dp0mcp-director-server.mjs" %*

@echo off
REM OMP API Trace — One-command setup
REM Usage: tools\trace.cmd [ompd args...]
REM
REM Starts trace server + ompd + browser viewer automatically.
REM
REM Example:
REM   tools\trace.cmd
REM   tools\trace.cmd --resume 019ebdb0-3611-7000-93a7-4a869f7c4c8f

bun "%~dp0trace.ts" %*

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  isCommandOnLocalPathMock,
  resolveCommandOnLocalPathMock,
  runProcessMock,
  runWslProcessMock,
  mergePersistedWindowsPathMock
} = vi.hoisted(() => ({
  isCommandOnLocalPathMock: vi.fn(),
  resolveCommandOnLocalPathMock: vi.fn(),
  runProcessMock: vi.fn(),
  runWslProcessMock: vi.fn(),
  mergePersistedWindowsPathMock: vi.fn()
}))

vi.mock('../ipc/command-path-resolver', () => ({
  isCommandOnLocalPath: isCommandOnLocalPathMock,
  resolveCommandOnLocalPath: resolveCommandOnLocalPathMock
}))

vi.mock('../../shared/child-process/run-process', () => ({ runProcess: runProcessMock }))
vi.mock('../wsl/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))
vi.mock('../pty/windows-environment-path', () => ({
  mergePersistedWindowsPath: mergePersistedWindowsPathMock,
  mergePersistedWindowsPathAsync: vi.fn()
}))
// Why: isolate the case from the host's real install dirs.
vi.mock('../ipc/local-agent-install-dir-detection', () => ({
  detectCommandsInInstallDirs: () => new Set<string>()
}))

import { detectInstalledAgents } from './agent-detection'
import { resetLocalOpenCodeGenerationProbes } from './opencode-generation-probe'

const originalPlatform = process.platform

beforeEach(() => {
  vi.resetAllMocks()
  resetLocalOpenCodeGenerationProbes()
  mergePersistedWindowsPathMock.mockImplementation(() => {})
  isCommandOnLocalPathMock.mockResolvedValue(false)
  resolveCommandOnLocalPathMock.mockResolvedValue(null)
  Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
})

function stubLocalCommands(commands: readonly string[]): void {
  isCommandOnLocalPathMock.mockImplementation(async (command: string) => commands.includes(command))
  resolveCommandOnLocalPathMock.mockImplementation(async (command: string) =>
    commands.includes(command) ? `/opt/bin/${command}` : null
  )
}

describe('opencode generation detection (local)', () => {
  it('reports only opencode2 when both bins resolve to a v2 binary', async () => {
    stubLocalCommands(['opencode', 'opencode2'])
    runProcessMock.mockResolvedValue({
      code: 0,
      signal: null,
      stdout: 'opencode v2.0.22\n',
      stderr: '',
      timedOut: false
    })

    await expect(detectInstalledAgents()).resolves.toEqual(['opencode2'])
  })

  it('keeps the v1 opencode id for a genuine v1 install', async () => {
    stubLocalCommands(['opencode', 'opencode2'])
    runProcessMock.mockResolvedValue({
      code: 0,
      signal: null,
      stdout: '1.18.34\n',
      stderr: '',
      timedOut: false
    })

    await expect(detectInstalledAgents()).resolves.toEqual(['opencode', 'opencode2'])
  })

  it('does not spawn a version probe when only one opencode id resolves', async () => {
    // #9297: the local path stays fs-only for every machine without the pair.
    stubLocalCommands(['opencode'])

    await expect(detectInstalledAgents()).resolves.toEqual(['opencode'])
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('leaves unrelated agents untouched alongside the opencode pair', async () => {
    stubLocalCommands(['claude', 'opencode', 'opencode2'])
    runProcessMock.mockResolvedValue({
      code: 0,
      signal: null,
      stdout: 'opencode v2.0.22\n',
      stderr: '',
      timedOut: false
    })

    await expect(detectInstalledAgents()).resolves.toEqual(['claude', 'opencode2'])
  })

  it('collapses a failed probe to opencode2 rather than the v1 false positive', async () => {
    stubLocalCommands(['opencode', 'opencode2'])
    runProcessMock.mockRejectedValue(new Error('probe unavailable'))

    await expect(detectInstalledAgents()).resolves.toEqual(['opencode2'])
  })
})

describe('opencode generation detection (WSL guest)', () => {
  const detectionStdout =
    '__ORCA_AGENT_PATH__opencode\t/usr/bin/opencode\n' +
    '__ORCA_AGENT_PATH__opencode2\t/usr/bin/opencode2\n'

  function stubWslDetection(versionStdout: string): void {
    runWslProcessMock.mockImplementation(async ({ script }: { script: string }) => {
      const base = { environmentResolved: true, stderr: '', timedOut: false }
      if (script.includes('"$resolved" --version')) {
        return { ...base, code: 0, stdout: versionStdout }
      }
      return { ...base, code: 0, stdout: detectionStdout }
    })
  }

  it('reports only opencode2 for a v2 guest', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    stubWslDetection('opencode v2.0.22\n')

    await expect(detectInstalledAgents({ wslDistro: 'Ubuntu' })).resolves.toEqual(['opencode2'])
  })

  it('keeps opencode for a v1 guest', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    stubWslDetection('1.18.34\n')

    await expect(detectInstalledAgents({ wslDistro: 'Ubuntu' })).resolves.toEqual([
      'opencode',
      'opencode2'
    ])
  })
})

import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const FPS = 25;

// Playwright's in-process VideoRecorder writes every screencast frame at least once at
// 25 fps. Pages that repaint faster (the simulator's CSS ring animation) therefore produce
// a .webm that runs longer than wall-clock time, so manifest event times drift away from
// the picture. This patch keeps the fractional remainder and drops surplus frames instead.
export function patchPlaywrightVideoTiming() {
  const lib = path.join(path.dirname(require.resolve('playwright-core/package.json')), 'lib');
  const { VideoRecorder } = require(path.join(lib, 'server/chromium/videoRecorder.js'));
  const { monotonicTime } = require(path.join(lib, 'utils/isomorphic/time.js'));
  if (!VideoRecorder?.prototype?.writeFrame || typeof monotonicTime !== 'function') {
    throw new Error('Unsupported playwright-core version: cannot patch VideoRecorder timing.');
  }
  if (VideoRecorder.prototype.__tillwiseTimingPatched) return;
  VideoRecorder.prototype.writeFrame = function writeFrame(frame, timestamp) {
    if (!this._process) throw new Error('VideoRecorder is not running.');
    if (this._isStopped) return;
    if (this._lastFrameBuffer) {
      const exact = FPS * (timestamp - this._lastFrameTimestamp) + (this._tillwiseCarry || 0);
      const repeatCount = Math.max(0, Math.round(exact));
      this._tillwiseCarry = exact - repeatCount;
      for (let i = 0; i < repeatCount; ++i) this._frameQueue.push(this._lastFrameBuffer);
      if (repeatCount) this._lastWritePromise = this._lastWritePromise.then(() => this._sendFrames());
    }
    this._lastFrameBuffer = frame;
    this._lastFrameTimestamp = timestamp;
    this._lastWriteTimestamp = monotonicTime();
  };
  VideoRecorder.prototype.__tillwiseTimingPatched = true;
}

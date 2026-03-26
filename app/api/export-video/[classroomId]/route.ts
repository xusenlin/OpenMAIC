import { type NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { CLASSROOMS_DIR } from '@/lib/server/classroom-storage';
import { promises as fs } from 'fs';
import { accessSync } from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { chromium } from 'playwright';

const VIDEO_WIDTH = 1280;
const VIDEO_HEIGHT = 720;

async function getAudioDuration(audioPath: string): Promise<number> {
  try {
    const output = execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${audioPath}"`,
      { encoding: 'utf-8' },
    );
    return parseFloat(output.trim()) || 0;
  } catch {
    return 0;
  }
}

async function getSceneAudioDuration(
  actions: Array<{ type: string; audioId?: string }>,
  audioDir: string,
): Promise<number> {
  let totalDuration = 0;
  for (const action of actions) {
    if (action.type === 'speech' && action.audioId) {
      const audioPath = path.join(audioDir, `${action.audioId}.wav`);
      try {
        await fs.access(audioPath);
        totalDuration += await getAudioDuration(audioPath);
      } catch {
        // Audio file not found, skip
      }
    }
  }
  return totalDuration;
}

function getChromePath(): string {
  const platform = process.platform;

  if (platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }

  if (platform === 'linux') {
    const possiblePaths = [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/local/bin/google-chrome',
      '/usr/local/bin/chromium',
    ];

    for (const chromePath of possiblePaths) {
      try {
        accessSync(chromePath);
        return chromePath;
      } catch {
        continue;
      }
    }
  }

  throw new Error(`Chrome/Chromium not found for platform: ${platform}`);
}

function estimateSpeechDuration(text: string): number {
  const cjkCount = (
    text.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || []
  ).length;
  const isCJK = cjkCount > text.length * 0.3;
  if (isCJK) {
    return Math.max(text.length * 0.15, 2);
  }
  return Math.max(text.split(/\s+/).length * 0.24, 2);
}

function estimateSceneDuration(actions: Array<{ type: string; text?: string }>): number {
  if (!actions) return 5;
  let total = 0;
  for (const action of actions) {
    if (action.type === 'speech' && action.text) {
      total += estimateSpeechDuration(action.text);
    }
  }
  return Math.max(total, 5);
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ classroomId: string }> },
) {
  try {
    const { classroomId } = await params;

    const classroomPath = path.join(CLASSROOMS_DIR, `${classroomId}.json`);
    const classroomData = await fs.readFile(classroomPath, 'utf-8');
    const classroom = JSON.parse(classroomData);

    const videoDir = path.join(CLASSROOMS_DIR, classroomId, 'video');
    const videoPath = path.join(videoDir, 'classroom.mp4');

    let videoExists = false;
    try {
      await fs.access(videoPath);
      videoExists = true;
    } catch {
      videoExists = false;
    }

    return apiSuccess({
      classroomId,
      videoExists,
      videoUrl: videoExists ? `/api/classroom-media/${classroomId}/video/classroom.mp4` : null,
      classroom: {
        id: classroom.id,
        name: classroom.stage?.name,
        scenesCount: classroom.scenes?.length || 0,
      },
    });
  } catch (error) {
    return apiError('INTERNAL_ERROR', 404, 'Classroom not found');
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ classroomId: string }> },
) {
  let browser = null;
  try {
    const { classroomId } = await params;

    const classroomPath = path.join(CLASSROOMS_DIR, `${classroomId}.json`);
    const classroomData = await fs.readFile(classroomPath, 'utf-8');
    const classroom = JSON.parse(classroomData);
    const scenes = classroom.scenes;

    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
    const classroomUrl = `${baseUrl}/classroom/${classroomId}`;

    const videoDir = path.join(CLASSROOMS_DIR, classroomId, 'video');
    const audioDir = path.join(CLASSROOMS_DIR, classroomId, 'audio');
    await fs.mkdir(videoDir, { recursive: true });

    const framesDir = path.join(videoDir, 'frames');
    await fs.mkdir(framesDir, { recursive: true });

    const debugLog: string[] = [];
    const debugFile = path.join(videoDir, 'debug.log');

    const log = (msg: string) => {
      const entry = `[${new Date().toISOString()}] ${msg}`;
      debugLog.push(entry);
      console.log(entry);
    };

    log(`Starting video export for classroom ${classroomId}`);
    log(`Classroom URL: ${classroomUrl}`);

    browser = await chromium.launch({
      headless: true,
      executablePath: getChromePath(),
    });

    const context = await browser.newContext({
      viewport: { width: VIDEO_WIDTH, height: VIDEO_HEIGHT },
    });
    const page = await context.newPage();

    await page.goto(classroomUrl, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);

    const sidebarToggleSelector = 'button[aria-label="Toggle sidebar"]';
    try {
      const toggleBtn = await page.$(sidebarToggleSelector);
      if (toggleBtn) {
        await toggleBtn.click();
        log('Clicked sidebar toggle to open scene list');
        await page.waitForTimeout(1000);
      }
    } catch (e) {
      log(`Failed to click sidebar toggle: ${e}`);
    }

    const pageInfo = await page.evaluate(() => {
      return {
        title: document.title,
        bodyChildren: document.body.children.length,
        readyState: document.readyState,
      };
    });

    log(`Page info: ${JSON.stringify(pageInfo)}`);

    await page.waitForTimeout(1000);

    const sceneCount = scenes.length;
    const framePaths: string[] = [];
    const sceneDurations: number[] = [];
    const sceneAudioFiles: string[][] = [];

    log(`Scene count: ${sceneCount}`);

    for (let i = 0; i < sceneCount; i++) {
      const scene = scenes[i];
      const audioFiles: string[] = [];
      for (const action of scene.actions || []) {
        if (action.type === 'speech' && action.audioId) {
          const audioPath = path.join(audioDir, `${action.audioId}.wav`);
          try {
            await fs.access(audioPath);
            audioFiles.push(audioPath);
          } catch {
            // Audio file not found, skip
          }
        }
      }
      sceneAudioFiles.push(audioFiles);

      let duration = 0;
      if (audioFiles.length > 0) {
        for (const audioFile of audioFiles) {
          duration += await getAudioDuration(audioFile);
        }
      }
      if (duration < 1) {
        duration = estimateSceneDuration(scene.actions || []);
      }
      sceneDurations.push(duration);

      log(`Starting capture for slide ${i + 1}/${sceneCount}: ${scene.title}`);

      const beforeCapture = await page.evaluate(() => {
        const win = window as unknown as {
          useStageStore?: {
            getState: () => {
              scenes: Array<{ id: string }>;
              currentSceneId: string;
            };
          };
        };
        if (win.useStageStore) {
          const state = win.useStageStore.getState();
          return { currentSceneId: state.currentSceneId, sceneCount: state.scenes.length };
        }
        return null;
      });

      log(`Store state before capture: ${JSON.stringify(beforeCapture)}`);

      const framePath = path.join(framesDir, `slide_${String(i).padStart(3, '0')}.png`);
      await page.screenshot({ path: framePath, type: 'png', fullPage: false });
      framePaths.push(framePath);

      log(
        `Captured slide ${i + 1}/${sceneCount}: ${scene.title} (${duration.toFixed(1)}s) - store says: ${JSON.stringify(beforeCapture)}`,
      );

      if (i < sceneCount - 1) {
        const targetScene = scenes[i + 1];
        log(`Attempting to switch to scene "${targetScene.id}"`);

        const sceneItemSelector = `[data-testid="scene-list"] [data-testid="scene-item"]:nth-child(${i + 2})`;
        try {
          const sceneItem = await page.$(sceneItemSelector);
          if (sceneItem) {
            await sceneItem.click();
            log(`Clicked scene item ${i + 2}`);
            await page.waitForTimeout(500);
          } else {
            log(`Scene item not found: ${sceneItemSelector}`);
          }
        } catch (e) {
          log(`Failed to click scene item: ${e}`);
        }
      }
    }

    await browser.close();
    browser = null;

    const concatListPath = path.join(videoDir, 'concat.txt');
    const concatLines: string[] = [];

    for (let i = 0; i < framePaths.length; i++) {
      const framePath = framePaths[i];
      const duration = sceneDurations[i];
      concatLines.push(`file '${framePath}'`);
      concatLines.push(`duration ${duration}`);
      if (i === framePaths.length - 1) {
        concatLines.push(`file '${framePath}'`);
      }
    }

    await fs.writeFile(concatListPath, concatLines.join('\n'), 'utf-8');

    const videoPath = path.join(videoDir, 'classroom.mp4');
    const tempDir = path.join(videoDir, 'temp');
    await fs.mkdir(tempDir, { recursive: true });

    try {
      for (let i = 0; i < framePaths.length; i++) {
        const framePath = framePaths[i];
        const duration = sceneDurations[i];
        const tempVideo = path.join(tempDir, `slide_${i}.mp4`);
        const audioFiles = sceneAudioFiles[i] || [];

        if (audioFiles.length > 0) {
          const concatAudioList = path.join(tempDir, `audio_concat_${i}.txt`);
          const audioLines = audioFiles.map((f) => `file '${f}'`).join('\n');
          await fs.writeFile(concatAudioList, audioLines, 'utf-8');
          const combinedAudio = path.join(tempDir, `audio_${i}.wav`);
          execSync(
            `ffmpeg -f concat -safe 0 -i "${concatAudioList}" -c copy -y "${combinedAudio}"`,
            { stdio: 'pipe' },
          );
          execSync(
            `ffmpeg -loop 1 -i "${framePath}" -i "${combinedAudio}" -vf "scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}" -map 0:v -map 1:a -t ${duration} -c:v libx264 -c:a aac -pix_fmt yuv420p -y "${tempVideo}"`,
            { stdio: 'pipe' },
          );
        } else {
          execSync(
            `ffmpeg -loop 1 -i "${framePath}" -vf "scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}" -t ${duration} -c:v libx264 -pix_fmt yuv420p -y "${tempVideo}"`,
            { stdio: 'pipe' },
          );
        }
      }

      const concatLines2: string[] = [];
      for (let i = 0; i < framePaths.length; i++) {
        const tempVideo = path.join(tempDir, `slide_${i}.mp4`);
        concatLines2.push(`file '${tempVideo}'`);
      }
      await fs.writeFile(concatListPath, concatLines2.join('\n'), 'utf-8');

      execSync(`ffmpeg -f concat -safe 0 -i "${concatListPath}" -c copy -y "${videoPath}"`, {
        stdio: 'pipe',
      });
    } catch (e) {
      console.error('ffmpeg failed:', e);
    }

    await fs.rm(tempDir, { recursive: true }).catch(() => {});
    await fs.unlink(concatListPath).catch(() => {});

    await fs.writeFile(debugFile, debugLog.join('\n'), 'utf-8');

    return apiSuccess({
      classroomId,
      videoPath,
      videoUrl: `/api/classroom-media/${classroomId}/video/classroom.mp4`,
    });
  } catch (error) {
    console.error('Video export error:', error);
    if (browser) await browser.close().catch(() => {});
    return apiError('INTERNAL_ERROR', 500, String(error));
  }
}

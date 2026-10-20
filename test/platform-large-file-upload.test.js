import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isLargeRemoteFileTransferError, uploadFile } from '../agent/rpa-adapters/assisted-platform.js';

const LARGE_FILE_ERROR = 'locator.setInputFiles: Cannot transfer files larger than 50Mb to a browser not co-located with the server';

function absentLocator() {
  return {
    count: async () => 0,
    nth() { return this; },
    isVisible: async () => false,
    isEnabled: async () => false,
    filter() { return this; }
  };
}

function createInput({ standardError = null, onSetFiles = null } = {}) {
  const state = {
    token: null,
    selected: false,
    standardCalls: 0,
    cleanupCalls: 0
  };
  const locator = {
    async isEnabled() { return true; },
    async isVisible() { return true; },
    async setInputFiles(value) {
      state.standardCalls += 1;
      const clearing = Array.isArray(value) && value.length === 0;
      if (standardError && !clearing) throw new Error(standardError);
      state.selected = !clearing;
      if (typeof onSetFiles === 'function') onSetFiles({ value, clearing, state });
    },
    async evaluate(fn, arg) {
      const source = fn.toString();
      if (source.includes('ancestors = []')) {
        return {
          accept: 'video/mp4',
          name: 'video',
          parentClass: 'upload-wrapper',
          parentId: '',
          insidePrimaryWrapper: true,
          visible: true,
          context: '上传视频 drag upload'
        };
      }
      if (source.includes('setAttribute(marker.attributeName')) {
        state.token = arg.token;
        return null;
      }
      if (source.includes('removeAttribute(marker.attributeName')) {
        state.cleanupCalls += 1;
        if (state.token === arg.token) state.token = null;
        return null;
      }
      if (source.includes('element.files?.length')) {
        return {
          count: state.selected ? 1 : 0,
          names: state.selected ? ['video.mp4'] : [],
          value: state.selected ? 'C:\\fakepath\\video.mp4' : ''
        };
      }
      return null;
    }
  };
  return { locator, state };
}

function createPage(inputs, { chooser = null, bodyText = '点击上传' } = {}) {
  const cdp = { setCalls: 0, detached: false };
  const trigger = {
    count: async () => chooser ? 1 : 0,
    nth() { return this; },
    isVisible: async () => Boolean(chooser),
    isEnabled: async () => Boolean(chooser),
    evaluate: async fn => fn.toString().includes('const target') ? true : null,
    click: async () => {}
  };
  const inputCollection = {
    count: async () => inputs.length,
    nth: index => inputs[index]?.locator || absentLocator()
  };
  const page = {
    frames: () => [page],
    url: () => 'https://example.test/upload',
    waitForTimeout: async () => {},
    waitForEvent: async event => event === 'filechooser' ? chooser : null,
    getByRole(_role, options = {}) {
      return options.name === '上传视频' ? trigger : absentLocator();
    },
    getByText() { return absentLocator(); },
    getByPlaceholder() { return absentLocator(); },
    getByLabel() { return absentLocator(); },
    locator(selector) {
      if (selector === 'body') return { allInnerTexts: async () => [typeof bodyText === 'function' ? bodyText() : bodyText] };
      if (selector === 'input[type="file"]') return inputCollection;
      return absentLocator();
    },
    context() {
      return {
        async newCDPSession() {
          return {
            async send(method, params = {}) {
              if (method === 'DOM.enable') return {};
              if (method === 'DOM.getFlattenedDocument') {
                const target = inputs.find(item => item.state.token);
                return target ? {
                  nodes: [{
                    nodeId: 11,
                    backendNodeId: 22,
                    frameId: 'child-frame-fixture',
                    attributes: ['data-codex-upload-token', target.state.token]
                  }]
                } : { nodes: [] };
              }
              if (method === 'DOM.setFileInputFiles') {
                cdp.setCalls += 1;
                assert.deepEqual(params.files, [path.resolve('C:\\fixtures\\video.mp4')]);
                const target = inputs.find(item => item.state.token);
                assert.ok(target, 'CDP target must be the tokened input');
                target.state.selected = true;
                return {};
              }
              if (method === 'DOM.performSearch') return { searchId: 'unused', resultCount: 0 };
              if (method === 'DOM.discardSearchResults') return {};
              throw new Error(`Unexpected CDP method: ${method}`);
            },
            async detach() { cdp.detached = true; }
          };
        }
      };
    }
  };
  return { page, cdp };
}

test('recognizes the Playwright remote-browser 50MB transfer limit', () => {
  assert.equal(isLargeRemoteFileTransferError(new Error(LARGE_FILE_ERROR)), true);
  assert.equal(isLargeRemoteFileTransferError(new Error('Element is not attached')), false);
});

test('large top-level or iframe file input falls back to local CDP exactly once', async () => {
  const first = createInput({ standardError: LARGE_FILE_ERROR });
  const second = createInput();
  const { page, cdp } = createPage([first, second]);

  const result = await uploadFile(page, 'C:\\fixtures\\video.mp4', {
    fileSelectors: ['input[type="file"]'],
    allowGenericFileInputFallback: false,
    requireUploadEvidence: false
  }, 1000);

  assert.equal(result.attached, true);
  assert.equal(result.method, 'cdp-local-file-path');
  assert.equal(result.originalMethod, 'file-input');
  assert.equal(result.largeFileFallback, true);
  assert.equal(result.attachAttempts, 1);
  assert.equal(first.state.standardCalls, 1);
  assert.equal(second.state.standardCalls, 0, 'must not select a second input after CDP accepted the file');
  assert.equal(cdp.setCalls, 1);
  assert.equal(cdp.detached, true);
  assert.equal(first.state.cleanupCalls, 1);
});

test('large filechooser upload uses the same local CDP fallback', async () => {
  const input = createInput();
  let chooserCalls = 0;
  const chooser = {
    async element() { return input.locator; },
    async setFiles() {
      chooserCalls += 1;
      throw new Error(LARGE_FILE_ERROR);
    }
  };
  const { page, cdp } = createPage([input], { chooser });

  const result = await uploadFile(page, 'C:\\fixtures\\video.mp4', {
    fileChooserLabels: ['上传视频'],
    fileSelectors: [],
    allowGenericFileInputFallback: false,
    requireUploadEvidence: false
  }, 1000);

  assert.equal(result.attached, true);
  assert.equal(result.method, 'cdp-local-file-path');
  assert.equal(result.originalMethod, 'filechooser');
  assert.equal(result.largeFileFallback, true);
  assert.equal(chooserCalls, 1);
  assert.equal(cdp.setCalls, 1);
});

test('non-size file injection errors fail immediately and are not silently swallowed', async () => {
  const input = createInput({ standardError: 'Access denied while setting files' });
  const { page, cdp } = createPage([input]);

  await assert.rejects(
    () => uploadFile(page, 'C:\\fixtures\\video.mp4', {
      fileSelectors: ['input[type="file"]'],
      allowGenericFileInputFallback: false,
      requireUploadEvidence: false
    }, 600000),
    error => {
      assert.equal(error.code, 'MATERIAL_FILE_INJECTION_FAILED');
      assert.match(error.message, /已找到素材上传控件/);
      assert.match(error.message, /Access denied/);
      return true;
    }
  );

  assert.equal(input.state.standardCalls, 1);
  assert.equal(cdp.setCalls, 0);
});


test('hung file input injection is cut off by a hard timeout', async () => {
  const input = createInput();
  input.locator.setInputFiles = async () => new Promise(() => {});
  const { page } = createPage([input]);
  const startedAt = Date.now();

  await assert.rejects(
    () => uploadFile(page, 'C:\\fixtures\\video.mp4', {
      name: 'B站',
      fileSelectors: ['input[type="file"]'],
      allowGenericFileInputFallback: false,
      requireUploadEvidence: false,
      materialFileInjectionTimeoutMs: 25
    }, 1000),
    error => {
      assert.equal(error.code, 'MATERIAL_FILE_INJECTION_TIMEOUT');
      assert.equal(error.stage, 'file-input 文件挂载');
      assert.match(error.message, /任务永久卡住/);
      return true;
    }
  );

  assert.ok(Date.now() - startedAt < 500, 'hard timeout should fail quickly');
});

test('Bilibili retries one unchanged initial uploader and marks a second no-op as safely retryable', async () => {
  const input = createInput();
  const { page } = createPage([input], { bodyText: '点击上传或将视频拖拽到此区域 上传视频' });

  await assert.rejects(
    () => uploadFile(page, 'C:\\fixtures\\video.mp4', {
      name: 'B站',
      fileSelectors: ['input[type="file"]'],
      allowGenericFileInputFallback: false,
      requireUploadEvidence: true,
      uploadInitialTextPattern: /点击上传或将视频拖拽到此区域/i,
      uploadEvidenceTextPattern: /稿件标题|视频上传中|上传完成/i,
      uploadEvidenceSelectors: [],
      uploadEvidenceTimeoutMs: 5,
      retryInitialFileInputOnce: true,
      materialFileInjectionTimeoutMs: 100
    }, 500),
    error => {
      assert.equal(error.code, 'MATERIAL_UPLOAD_NOT_STARTED');
      assert.equal(error.uploadDefinitelyNotStarted, true);
      assert.equal(error.attachAttempts, 2);
      assert.equal(error.materialAttachment.attached, false);
      assert.equal(error.materialAttachment.evidence.initialVisible, true);
      return true;
    }
  );

  assert.equal(input.state.standardCalls, 3, 'first selection, clear, and one safe reselection');
});

test('Bilibili safe reselection succeeds when the editor appears on the second change event', async () => {
  let nonEmptySelections = 0;
  let text = '点击上传或将视频拖拽到此区域 上传视频';
  const input = createInput({
    onSetFiles({ clearing }) {
      if (clearing) return;
      nonEmptySelections += 1;
      if (nonEmptySelections >= 2) text = '稿件标题 视频简介 基础设置';
    }
  });
  const { page } = createPage([input], { bodyText: () => text });

  const result = await uploadFile(page, 'C:\\fixtures\\video.mp4', {
    name: 'B站',
    fileSelectors: ['input[type="file"]'],
    allowGenericFileInputFallback: false,
    requireUploadEvidence: true,
    uploadInitialTextPattern: /点击上传或将视频拖拽到此区域/i,
    uploadEvidenceTextPattern: /稿件标题|视频上传中|上传完成/i,
    uploadEvidenceSelectors: [],
    uploadEvidenceTimeoutMs: 5,
    retryInitialFileInputOnce: true,
    materialFileInjectionTimeoutMs: 100
  }, 500);

  assert.equal(result.attached, true);
  assert.equal(result.attachAttempts, 2);
  assert.equal(result.evidence.textMatched, true);
  assert.equal(input.state.standardCalls, 3);
});


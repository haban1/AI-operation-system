export function aiConnectionPresentation(ai) {
  if (ai.mode === 'mock') return { label: '当前使用模拟模式', short: '模拟', tone: 'is-info', passed: false, detail: '模拟模式不会验证在线连接。' };
  if (!ai.configured) return { label: '在线服务等待配置', short: '待配置', tone: 'is-warning', passed: false, detail: '请填写 Key、接口地址和模型。' };
  if (ai.connectionTest?.status === 'PASSED') return { label: '对话模型最近测试通过', short: '测试通过', tone: 'is-ready', passed: true, detail: '仅验证对话连接，未验证视觉 / OCR 能力；不代表持续在线。' };
  if (ai.connectionTest?.status === 'FAILED') return { label: '对话连接测试失败', short: '测试失败', tone: 'is-warning', passed: false, detail: '请核对 Key、接口地址、模型及权限后重试。' };
  return { label: '已配置，待测试', short: '待测试', tone: 'is-info', passed: false, detail: '保存配置不代表连接成功；服务重启后需重新测试。' };
}

export function bindAiModelSettings({ form, ai, api, toast, refresh }) {
  const field = name => form.elements.namedItem(name);
  const fetchButton = form.querySelector('#aiFetchModels');
  const message = form.querySelector('#aiModelDiscoveryStatus');
  const testButton = form.querySelector('#aiConnectionTest');
  const testNote = form.querySelector('#aiConnectionTestNote');
  const pickers = [...form.querySelectorAll('[data-ai-model-picker]')];
  const credentials = () => JSON.stringify([field('baseUrl').value.trim(), field('apiKey').value.trim()]);
  const configuration = () => JSON.stringify(['mode','baseUrl','apiKey','model','visionModel','asrModel','contentModel','imageContentModel','trafficPredictionModel','embeddingModel'].map(name => field(name)?.value.trim() || ''));
  const initial = configuration();
  let credentialSnapshot = credentials();
  let requestId = 0;
  let testing = false;
  const dirty = () => configuration() !== initial;
  function updateTestState() {
    testButton.disabled = testing || dirty() || (ai.mode === 'online' && !ai.configured);
    testNote.textContent = dirty() ? '配置尚未保存，请先保存再测试，避免测试到旧模型。' : '连接测试仅验证已保存的对话模型，可能产生少量调用费用；不验证视觉 / OCR。';
  }
  function clearPickers() {
    for (const picker of pickers) {
      picker.replaceChildren(new Option('获取模型后可在此选择，也可在下方手动填写', ''));
      picker.disabled = true;
    }
  }
  function changed() {
    const next = credentials();
    if (next !== credentialSnapshot) {
      credentialSnapshot = next;
      requestId += 1;
      clearPickers();
      fetchButton.disabled = false;
      fetchButton.textContent = '获取可用模型';
      message.textContent = 'Key 或接口地址已修改，请重新获取模型。不会自动保存当前填写内容。';
    }
    updateTestState();
  }
  form.addEventListener('input', changed);
  form.addEventListener('change', changed);
  for (const picker of pickers) picker.addEventListener('change', () => {
    if (picker.value) {
      field(picker.dataset.aiModelPicker).value = picker.value;
      updateTestState();
    }
  });
  fetchButton.onclick = async () => {
    const id = ++requestId;
    const snapshot = credentials();
    clearPickers();
    fetchButton.disabled = true;
    fetchButton.textContent = '正在获取…';
    message.textContent = '仅查询填写的接口地址；不会保存配置或自动选择模型。';
    try {
      const result = await api('/api/settings/ai/models', { method: 'POST', body: JSON.stringify({ baseUrl: field('baseUrl').value.trim(), apiKey: field('apiKey').value.trim() }) });
      if (!form.isConnected || id !== requestId || snapshot !== credentials()) return;
      for (const picker of pickers) {
        picker.replaceChildren(new Option('请选择模型（也可继续手动填写）', ''));
        for (const model of result.models || []) picker.add(new Option(model, model));
        const current = field(picker.dataset.aiModelPicker).value.trim();
        if ((result.models || []).includes(current)) picker.value = current;
        picker.disabled = !result.models?.length;
      }
      message.textContent = (result.message || '模型列表已获取。') + (result.truncated ? '列表较长，仅展示前 2000 个，其余可手动填写。' : '');
    } catch (error) {
      if (form.isConnected && id === requestId) {
        message.textContent = error.status === 404
          ? '本地后台尚未加载模型查询接口，请先停止并重新启动本地服务，再刷新页面重试。这不是千问返回的模型错误；当前配置未改变。'
          : error.message + ' 当前配置未改变，仍可手动填写模型。';
      }
    } finally {
      if (form.isConnected && id === requestId) { fetchButton.disabled = false; fetchButton.textContent = '获取可用模型'; }
    }
  };
  testButton.onclick = async () => {
    if (dirty()) return toast('请先保存当前配置，再测试连接。', true);
    testing = true;
    testButton.disabled = true;
    testButton.textContent = '测试中…';
    let succeeded = false;
    try {
      const result = await api('/api/settings/ai/test', { method: 'POST', body: '{}' });
      succeeded = true;
      toast(result.result?.message || '对话连接测试成功');
    } catch (error) {
      toast(error.message + (error.detail ? '：' + error.detail : ''), true);
    } finally {
      testing = false;
      if (form.isConnected) {
        testButton.textContent = '测试对话连接';
        updateTestState();
        // A test result for saved settings must not discard edits made while waiting.
        if (!dirty()) await refresh();
        else testNote.textContent = '刚才测试的是已保存配置（' + (succeeded ? '测试完成' : '测试失败') + '），当前修改仍需保存后重新测试。';
      }
    }
  };
  updateTestState();
}

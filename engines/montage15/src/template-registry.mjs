import { fail } from './domain.mjs';

export class TemplateRegistry {
  constructor(store, templates, defaultIds) {
    this.store = store;
    this.templates = templates;
    this.defaultIds = defaultIds || templates.filter(template => !template.hidden).map(template => template.id);
  }

  async list() {
    const decisions = await this.store.all('template-state');
    return this.templates.filter(template => !template.hidden).map(template => {
      const decision = decisions.find(item => item.templateId === template.id && item.version === template.version);
      const enabled = decision ? decision.enabled : this.defaultIds.includes(template.id);
      return { ...template, enabled, status: enabled ? 'accepted' : 'candidate', selectedAt: decision?.updatedAt || null };
    });
  }

  async enabled() {
    return (await this.list()).filter(template => template.enabled);
  }

  async setEnabled(id, input) {
    if (Object.keys(input).some(key => !['enabled', 'version'].includes(key)) || typeof input.enabled !== 'boolean') fail(400, 'INVALID_TEMPLATE_STATE', '请选择启用或停用模板');
    const template = this.templates.find(item => item.id === id && !item.hidden);
    if (!template) fail(404, 'UNKNOWN_TEMPLATE', '模板不存在');
    if (input.version !== template.version) fail(409, 'TEMPLATE_VERSION_CHANGED', '模板版本已变化，请刷新后重新选择');
    await this.store.put('template-state', { id, templateId: id, version: template.version, enabled: input.enabled, updatedAt: new Date().toISOString() });
    return (await this.list()).find(item => item.id === id);
  }
}

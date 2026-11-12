import path from 'node:path';
import { createVideoStudio } from '../../engines/video-studio/server.mjs';
import { createMontageWorkbench } from './montage-workbench.js';

// Keep main's navigation, Signal settings and library contracts while replacing
// only the footage editor. Both producers use the same admission boundary.
export async function createContentWorkbench({ stateDir, montageDir, publicDir, library, publishingLibrary }) {
  const studio = createVideoStudio({ stateDir, automaticUrl: '/integrations/ai-signal/', publishingLibrary, assistantEnabled: false });
  const montage = await createMontageWorkbench({
    stateDir: montageDir || path.join(stateDir, 'montage15'), publicDir, library, publishingLibrary,
  });
  return {
    capabilities: montage.capabilities,
    async listOutputs(options) {
      const [existing, edited] = await Promise.all([studio.listOutputs(options), montage.listOutputs()]);
      return { ...existing, items: [...existing.items, ...edited.items] };
    },
    resolveOutput(id) { return id.startsWith('montage-') ? montage.resolveOutput(id) : studio.resolveOutput(id); },
    handle(req, res, options = {}) {
      const local = new URL(req.url, 'http://localhost').pathname.slice((options.mountPath || '').length);
      if (local.startsWith('/montage/') || /^\/api\/studio\/outputs\/montage-[a-f0-9-]+\/file$/.test(local)) {
        return montage.handle(req, res, options);
      }
      return studio.handle(req, res, options);
    },
    close: () => montage.close?.(),
  };
}

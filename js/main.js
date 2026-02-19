import './viewer-app.js';
import { initOpsPanel } from './ui/ops-panel.js';

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => initOpsPanel(), { once: true });
} else {
  initOpsPanel();
}

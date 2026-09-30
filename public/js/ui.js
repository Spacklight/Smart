function ensureUiFeedback() {
  if (!document.getElementById('toastStack')) {
    const stack = document.createElement('div');
    stack.id = 'toastStack';
    stack.className = 'toast-stack';
    document.body.appendChild(stack);
  }
}

function showToast(message, type = 'info') {
  ensureUiFeedback();
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  const icon = type === 'success' ? '✓' : type === 'error' ? '!' : type === 'warning' ? '!' : 'i';
  toast.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-message"></span><button class="toast-close" aria-label="Close">×</button>`;
  toast.querySelector('.toast-message').textContent = String(message ?? '');
  toast.querySelector('.toast-close').onclick = () => toast.remove();
  document.getElementById('toastStack').appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 220); }, 4200);
}

function showConfirm(message, options = {}) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `<div class="confirm-card"><div class="confirm-icon">!</div><h3>${options.title || 'Please confirm'}</h3><p></p><div class="confirm-actions"><button class="btn" data-cancel>${options.cancelText || 'Cancel'}</button><button class="btn ${options.danger ? 'btn-danger' : 'btn-primary'}" data-ok>${options.confirmText || 'Continue'}</button></div></div>`;
    overlay.querySelector('p').textContent = String(message ?? '');
    const finish = value => { overlay.remove(); resolve(value); };
    overlay.querySelector('[data-cancel]').onclick = () => finish(false);
    overlay.querySelector('[data-ok]').onclick = () => finish(true);
    overlay.addEventListener('click', e => { if (e.target === overlay) finish(false); });
    document.body.appendChild(overlay);
  });
}



function showPrompt(message, options = {}) {
  return new Promise(resolve => {
    ensureUiFeedback();
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    const multiline = !!options.multiline;
    const input = multiline
      ? `<textarea class="form-input ui-prompt-input" rows="${options.rows || 5}" maxlength="${options.maxLength || 2000}" style="width:100%; margin-top:.75rem; resize:vertical;"></textarea>`
      : `<input class="form-input ui-prompt-input" type="${options.type || 'text'}" maxlength="${options.maxLength || 200}" style="width:100%; margin-top:.75rem;">`;
    overlay.innerHTML = `
      <div class="confirm-card ui-prompt-card">
        <div class="confirm-icon">${options.icon || '✎'}</div>
        <h3>${options.title || 'Enter information'}</h3>
        <p class="ui-prompt-message"></p>
        ${input}
        <div class="confirm-actions">
          <button class="btn" data-cancel>${options.cancelText || 'Cancel'}</button>
          <button class="btn btn-primary" data-ok>${options.confirmText || 'Continue'}</button>
        </div>
      </div>`;
    overlay.querySelector('.ui-prompt-message').textContent = String(message ?? '');
    const field = overlay.querySelector('.ui-prompt-input');
    field.value = options.value ?? '';
    const finish = value => { overlay.remove(); resolve(value); };
    overlay.querySelector('[data-cancel]').onclick = () => finish(null);
    overlay.querySelector('[data-ok]').onclick = () => finish(field.value);
    overlay.addEventListener('click', e => { if (e.target === overlay) finish(null); });
    document.body.appendChild(overlay);
    requestAnimationFrame(() => { field.focus(); field.select?.(); });
    field.addEventListener('keydown', e => {
      if (!multiline && e.key === 'Enter') { e.preventDefault(); finish(field.value); }
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
    });
  });
}

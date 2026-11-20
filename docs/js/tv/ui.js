/**
 * TV menu interaction for three input styles:
 *   1. D-pad / arrow keys  → spatial focus movement
 *   2. Mouse / touch       → native hover + click
 *   3. Hands               → hover with a circular "dwell to select" ring
 *
 * Hand selection makes the whole console usable without a controller, which is
 * the point of the project.
 */
import { clamp } from '../shared/util.js';

const DWELL_MS = 780;

export class UiNav {
  constructor() {
    this.scope = null;
    this.items = [];
    this.index = -1;
    /** @type {Map<string, {el:Element, start:number, progress:number, cooldown:number}>} */
    this.pointers = new Map();
    this.onActivate = null;
    this.onHover = null;
  }

  setScope(root) {
    this.scope = root || null;
    this.items = [];
    this.index = -1;
    this.pointers.clear();
    this.refresh();
    // Screens/overlays fade in, so a same-tick measurement can see opacity 0.
    // Refresh again after the first paint to guarantee a focused item.
    if (this.scope) {
      const root = this.scope;
      const retry = () => {
        if (this.scope === root && !this.items.length) this.refresh();
      };
      requestAnimationFrame(retry);
      setTimeout(retry, 80);
    }
  }

  refresh() {
    if (!this.scope) return;
    const nodes = this.scope.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), [data-focusable]:not([disabled])',
    );
    this.items = [...nodes].filter((el) => {
      if (el.closest('[aria-hidden="true"]')) return false;
      if (el.classList.contains('overlay')) return false;
      return UiNav.isVisible(el);
    });
    for (const el of this.items) {
      el.classList.remove('is-focused');
      if (el.dataset.focusBound) continue;
      el.dataset.focusBound = '1';
      el.addEventListener('focus', () => this.focusEl(el, false));
    }
    if (this.items.length) this.focus(0, false);
  }

  static isVisible(el) {
    if (!el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none') return false;
    // A screen or overlay that is mid-fade still counts as visible. Avoid the
    // opacity/visibility check there because a just-added `.open` class can
    // report the pre-transition values for one style recalc.
    const inOpenLayer = el.closest('.overlay.open, .screen.active');
    if (inOpenLayer) return true;
    return style.visibility !== 'hidden' && Number(style.opacity) > 0.05;
  }

  focus(index, scroll = false) {
    if (!this.items.length) return;
    const next = clamp(index, 0, this.items.length - 1);
    if (this.items[this.index]) this.items[this.index].classList.remove('is-focused');
    this.index = next;
    const el = this.items[next];
    el.classList.add('is-focused');
    if (scroll && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  focusEl(el, scroll = false) {
    const idx = this.items.indexOf(el);
    if (idx >= 0) this.focus(idx, scroll);
  }

  get focused() {
    return this.items[this.index] || null;
  }

  move(dir) {
    if (!this.items.length) return;
    if (this.index < 0) this.focus(0);
    const current = this.items[this.index];
    const cr = current.getBoundingClientRect();
    const cx = cr.left + cr.width / 2;
    const cy = cr.top + cr.height / 2;
    const vx = dir === 'left' ? -1 : dir === 'right' ? 1 : 0;
    const vy = dir === 'up' ? -1 : dir === 'down' ? 1 : 0;

    let best = null;
    let bestScore = Infinity;
    for (const el of this.items) {
      if (el === current) continue;
      const r = el.getBoundingClientRect();
      const ex = r.left + r.width / 2 - cx;
      const ey = r.top + r.height / 2 - cy;
      const along = ex * vx + ey * vy;
      if (along < 6) continue; // must be in the requested direction
      const across = Math.abs(ex * vy - ey * vx);
      const dist = Math.hypot(ex, ey);
      const score = dist + across * 2.2;
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    if (best) this.focusEl(best);
  }

  activate() {
    const el = this.focused;
    if (!el) return;
    if (el instanceof HTMLInputElement && el.type === 'range') {
      // Enter on a slider nudges it, so keyboards can still tune things.
      this.adjust(5);
      return;
    }
    el.click();
  }

  adjust(delta) {
    const el = this.focused;
    if (!(el instanceof HTMLInputElement) || el.type !== 'range') return;
    const step = Number(el.step) || 1;
    el.value = String(clamp(Number(el.value) + delta * step, Number(el.min), Number(el.max)));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /** Dwell logic for a hand pointer hovering at client coordinates. */
  dwellAt(pointer, clientX, clientY, now) {
    if (!this.scope) return { progress: 0, hovering: null };
    const el = document.elementFromPoint(clientX, clientY);
    return this._dwell(pointer, el, now);
  }

  _dwell(pointer, hitEl, now) {
    const key = pointer.id;
    const focusable = hitEl && hitEl.closest ? hitEl.closest('button, input, [data-focusable]') : null;
    const valid = focusable && this.scope && this.scope.contains(focusable) && !focusable.disabled;
    let st = this.pointers.get(key);
    if (!st) {
      st = { el: null, start: 0, progress: 0, cooldown: 0, hovering: null };
      this.pointers.set(key, st);
    }
    if (!valid) {
      st.el = null;
      st.progress = 0;
      st.hovering = null;
      return { progress: 0, hovering: null };
    }
    if (st.el !== focusable) {
      st.el = focusable;
      st.start = now;
      st.progress = 0;
      this.focusEl(focusable);
      if (this.onHover) this.onHover(focusable);
    }
    // A fast swipe should not accidentally press things: require a calm hover.
    if (pointer.speed > 900) {
      st.start = now;
      st.progress = 0;
    } else if (now - st.cooldown > 380) {
      st.progress = clamp((now - st.start) / DWELL_MS, 0, 1);
      if (st.progress >= 1) {
        st.cooldown = now;
        st.start = now;
        st.progress = 0;
        if (focusable instanceof HTMLInputElement && focusable.type === 'range') {
          this.focusEl(focusable);
        } else {
          focusable.click();
        }
      }
    } else {
      st.progress = 0;
    }
    st.hovering = focusable;
    return { progress: st.progress, hovering: focusable };
  }
}

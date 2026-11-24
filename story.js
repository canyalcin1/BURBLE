/* Presentation layer: one scroll story, scroll-driven motion (GSAP ScrollTrigger), presenter keys. */
'use strict';
(() => {
  const chapters = [...document.querySelectorAll('.ch')];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const label = document.getElementById('chLabel');
  const navLinks = [...document.querySelectorAll('.nav nav a')];
  let current = 0;

  /* ---------- chapter tracking ---------- */
  const setCurrent = i => {
    current = i; const ch = chapters[i];
    label.textContent = `${String(i).padStart(2, '0')} · ${ch.dataset.ch}`;
    navLinks.forEach(a => a.classList.toggle('cur', a.dataset.group.split(' ').includes(ch.id)));
  };
  const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) setCurrent(chapters.indexOf(e.target)); }), { rootMargin: '-45% 0px -54% 0px' });
  chapters.forEach(c => io.observe(c));
  addEventListener('scroll', () => document.getElementById('nav').classList.toggle('scrolled', scrollY > 8), { passive: true });

  /* ---------- presenter navigation: → ← PgDn PgUp, clicker friendly ---------- */
  const navH = () => document.getElementById('nav').offsetHeight;
  // Works from positions only, so it is correct even mid-scroll. Long chapters are paged through first.
  let pending = null, pendingAt = 0;
  const go = dir => {
    const nh = navH(), vh = innerHeight - nh;
    const y = pending != null && Date.now() - pendingAt < 900 ? pending : scrollY;
    const starts = chapters.map(c => Math.max(0, Math.round(c.getBoundingClientRect().top + scrollY - nh)));
    let i = 0; starts.forEach((s, k) => { if (s <= y + 6) i = k; });
    let target;
    if (dir > 0) {
      const nextStart = i + 1 < starts.length ? starts[i + 1] : document.documentElement.scrollHeight - innerHeight;
      target = nextStart - y > vh + 40 ? Math.min(y + vh * .85, nextStart) : nextStart;
    } else {
      target = y > starts[i] + 6 ? starts[i] : starts[Math.max(0, i - 1)];
    }
    pending = target; pendingAt = Date.now();
    if (!reduce && window.gsap && window.ScrollToPlugin) {
      gsap.to(window, { scrollTo: { y: target, autoKill: false }, duration: Math.min(1.1, .55 + Math.abs(target - scrollY) / 4000), ease: 'power3.inOut', overwrite: true, onComplete: () => { pending = null; } });
    } else { document.documentElement.style.scrollBehavior = 'auto'; scrollTo(0, target); pending = null; }
  };
  addEventListener('keydown', e => {
    if (e.target.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (['ArrowRight', 'PageDown'].includes(e.key) || (e.key === ' ' && !e.target.closest('button, a, summary'))) { e.preventDefault(); go(1); }
    else if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); go(-1); }
  });
  document.getElementById('next').onclick = () => go(1);
  document.getElementById('prev').onclick = () => go(-1);

  /* ---------- reveal helpers (fallback without GSAP or with reduced motion) ---------- */
  const compare = document.querySelector('.compare');
  if (reduce || !window.gsap || !window.ScrollTrigger) {
    document.querySelectorAll('[data-rv], .split, .tiers, .road li').forEach(el => el.classList.add('shown'));
    compare.classList.add('in');
    const p = document.getElementById('prog');
    addEventListener('scroll', () => { p.style.transform = `scaleX(${scrollY / (document.documentElement.scrollHeight - innerHeight)})`; }, { passive: true });
    return;
  }
  gsap.registerPlugin(ScrollTrigger, ...(window.ScrollToPlugin ? [ScrollToPlugin] : []));
  const ease = 'power3.out';
  // CSS smooth-scroll fights scripted scrolling; GSAP owns it now, anchors included.
  document.documentElement.style.scrollBehavior = 'auto';
  document.addEventListener('click', e => {
    const a = e.target.closest('a[href^="#"]'); if (!a || a.getAttribute('href').length < 2) return;
    const t = document.querySelector(a.getAttribute('href')); if (!t) return;
    e.preventDefault();
    const y = a.getAttribute('href') === '#top' ? 0 : t.getBoundingClientRect().top + scrollY - navH();
    gsap.to(window, { scrollTo: { y, autoKill: false }, duration: Math.min(1.4, .6 + Math.abs(y - scrollY) / 5000), ease: 'power3.inOut', overwrite: true });
    history.replaceState(null, '', a.getAttribute('href'));
  });

  /* progress bar */
  gsap.to('#prog', { scaleX: 1, ease: 'none', scrollTrigger: { start: 0, end: 'max', scrub: .3 } });

  /* headings: word-by-word rise */
  document.querySelectorAll('.split').forEach(h => {
    h.innerHTML = h.textContent.trim().split(/\s+/).map(w => `<span class="w"><span>${w}</span></span>`).join(' ');
    gsap.from(h.querySelectorAll('.w > span'), { yPercent: 110, duration: .9, ease, stagger: .04, scrollTrigger: { trigger: h, start: 'top 85%' } });
  });
  /* kicker lines */
  gsap.utils.toArray('.kicker').forEach(k => gsap.from(k, { opacity: 0, x: -16, duration: .6, ease, scrollTrigger: { trigger: k, start: 'top 88%' } }));

  /* generic blocks: children stagger up */
  gsap.utils.toArray('[data-rv]').forEach(el => {
    const kids = el.children.length > 1 && !el.matches('figure, .card, p, h3') ? el.children : [el];
    gsap.from(kids, { opacity: 0, y: 28, duration: .8, ease, stagger: .08, clearProps: 'transform', scrollTrigger: { trigger: el, start: 'top 86%' } });
  });

  /* problem statement: words light up as you scroll through it */
  const st = document.getElementById('statement');
  st.innerHTML = st.innerHTML.replace(/(<em>|<\/em>)|([^\s<]+)/g, (m, tag, word) => tag ? m : `<span class="sw-word">${word}</span>`);
  gsap.fromTo(st.querySelectorAll('.sw-word'), { opacity: .14 }, { opacity: 1, stagger: .1, ease: 'none', scrollTrigger: { trigger: st, start: 'top 80%', end: 'bottom 45%', scrub: .4 } });

  /* positioning diagram: nodes arrive, links draw, core pulses */
  const fd = document.getElementById('flowdiag');
  gsap.timeline({ scrollTrigger: { trigger: fd, start: 'top 75%', end: 'bottom 55%', scrub: .6 } })
    .from(fd.querySelectorAll('.node'), { opacity: 0, y: 30, stagger: .5, ease })
    .from(fd.querySelectorAll('.link'), { scaleX: 0, transformOrigin: 'left center', stagger: .5, ease: 'none' }, .25);
  gsap.to(fd.querySelector('.core'), { boxShadow: '0 0 0 10px rgba(59,130,246,.10), 0 20px 40px -20px rgba(30,64,175,.6)', repeat: -1, yoyo: true, duration: 1.6, ease: 'sine.inOut' });

  /* raw → standard */
  ScrollTrigger.create({ trigger: compare, start: 'top 70%', onEnter: () => compare.classList.add('in') });
  gsap.from('.pane.raw', { x: -40, opacity: 0, duration: .9, ease, scrollTrigger: { trigger: compare, start: 'top 80%' } });
  gsap.from('.pane.std', { x: 40, opacity: 0, duration: .9, ease, scrollTrigger: { trigger: compare, start: 'top 80%' } });

  /* pipeline: re-run live when the chapter is presented */
  let lastRun = 0;
  ScrollTrigger.create({ trigger: '#hat', start: 'top 55%', onEnter: () => { if (Date.now() - lastRun > 8000 && typeof run === 'function') { lastRun = Date.now(); run(); } } });
  gsap.from('.steps li', { opacity: 0, x: -24, duration: .6, stagger: .08, ease, scrollTrigger: { trigger: '.steps', start: 'top 80%' } });
  gsap.from('.console', { opacity: 0, y: 40, duration: .9, ease, scrollTrigger: { trigger: '.console', start: 'top 85%' } });

  /* decision tiers: cards rise, numbers recount */
  gsap.from('.tier', { opacity: 0, y: 50, rotateX: -12, transformPerspective: 800, duration: .9, stagger: .12, ease, clearProps: 'transform', scrollTrigger: { trigger: '.tiers', start: 'top 80%',
    onEnter: () => ['tAuto', 'tSug', 'tFlag'].forEach(id => { const el = document.getElementById(id), v = +el.dataset.v || +el.textContent || 0; el.dataset.v = 0; typeof countUp === 'function' && countUp(el, v); }) } });

  /* charts animate when seen, not at load */
  ['cPareto', 'cLoss', 'cFc'].forEach(id => ScrollTrigger.create({ trigger: '#' + id, start: 'top 85%', once: true, onEnter: () => { const c = typeof charts !== 'undefined' && charts[id]; if (c) { c.reset(); c.update(); } } }));
  ScrollTrigger.create({ trigger: '#lca', start: 'top 85%', once: true, onEnter: () => typeof renderLca === 'function' && (['kCo2', 'kLoss', 'kMwh'].forEach(id => document.getElementById(id).dataset.v = 0), renderLca()) });

  /* roadmap: line draws with scroll, stages switch on */
  const road = document.getElementById('road');
  gsap.fromTo(road, { '--fill': 0 }, { '--fill': 1, ease: 'none', scrollTrigger: { trigger: road, start: 'top 70%', end: 'bottom 60%', scrub: .5 } });
  road.querySelectorAll('li').forEach(li => ScrollTrigger.create({ trigger: li, start: 'top 68%', onEnter: () => li.classList.add('lit'), onLeaveBack: () => li.classList.remove('lit') }));
  gsap.from(road.querySelectorAll('li'), { opacity: 0, y: 24, clearProps: 'transform', duration: .7, stagger: .1, ease, scrollTrigger: { trigger: road, start: 'top 80%' } });

  /* ending */
  gsap.from('.endline', { opacity: 0, y: 60, scale: .96, duration: 1.1, ease, scrollTrigger: { trigger: '#son', start: 'top 70%' } });
  gsap.from('.team.big li', { opacity: 0, y: 20, duration: .6, stagger: .08, ease, scrollTrigger: { trigger: '#son', start: 'top 60%' } });

  /* hero instrument drifts slightly on scroll (depth) */
  gsap.to('.instrument', { yPercent: -12, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });

  addEventListener('load', () => ScrollTrigger.refresh());
})();

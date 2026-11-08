/* SHOWHAUS Studio embed — paste into any page:
 *   <script src="https://showhaus.app/studio/embed.js" data-project="arncliffe-central" async></script>
 * Optional: data-ratio="16/10" (default; 4/5 below 560 px wide), data-src="your-campaign".
 * Renders a responsive, lazy-loaded iframe of the walkthrough plus a small "Made with SHOWHAUS" link. No cookies. */
(function () {
  var scripts = document.querySelectorAll('script[src*="/studio/embed.js"]:not([data-showhaus-done])');
  for (var i = 0; i < scripts.length; i++) mount(scripts[i]);

  function mount(s) {
    s.setAttribute('data-showhaus-done', '1');
    var slug = String(s.getAttribute('data-project') || 'arncliffe-central').replace(/[^a-z0-9-]/g, '');
    var base = new URL('./', s.src).href; // …/studio/
    var host = (location.hostname || 'file').replace(/[^a-z0-9.-]/gi, '').slice(0, 40);
    var src = s.getAttribute('data-src') || ('embed-' + host);
    var url = base + '?p=' + encodeURIComponent(slug) + '&embed=1&src=' + encodeURIComponent(src);

    var wrap = document.createElement('div');
    wrap.className = 'showhaus-embed';
    wrap.setAttribute('data-project', slug);
    wrap.style.cssText = 'position:relative;width:100%;max-width:100%;margin:0 0 4px;box-sizing:border-box;';
    var frameBox = document.createElement('div');
    frameBox.style.cssText = 'position:relative;width:100%;overflow:hidden;border-radius:10px;background:#efe6d4;box-shadow:0 1px 0 rgba(29,39,51,.08),0 10px 30px rgba(29,39,51,.14);';
    var ratio = s.getAttribute('data-ratio') || '16/10';
    function size() {
      var w = wrap.getBoundingClientRect().width || 600;
      var r = w < 560 ? [4, 5] : ratio.split('/').map(Number);
      var h = Math.round(w * r[1] / r[0]);
      frameBox.style.height = Math.max(420, Math.min(h, 820)) + 'px';
    }
    var iframe = document.createElement('iframe');
    iframe.title = 'SHOWHAUS 3D walkthrough';
    iframe.setAttribute('loading', 'lazy');
    iframe.setAttribute('allow', 'fullscreen');
    iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    iframe.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;display:block;';
    frameBox.appendChild(iframe);
    var link = document.createElement('a');
    link.href = base + '?p=' + encodeURIComponent(slug) + '&src=' + encodeURIComponent(src + '-link');
    link.target = '_blank'; link.rel = 'noopener';
    link.textContent = 'Made with SHOWHAUS';
    link.style.cssText = 'display:inline-block;margin-top:6px;font:500 12px/1.2 ui-monospace,Menlo,monospace;color:#4a5566;text-decoration:none;';
    wrap.appendChild(frameBox); wrap.appendChild(link);
    s.parentNode.insertBefore(wrap, s.nextSibling);
    size();
    if (window.ResizeObserver) new ResizeObserver(size).observe(wrap); else window.addEventListener('resize', size);

    var load = function () { if (!iframe.src) iframe.src = url; };
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (es) { for (var k = 0; k < es.length; k++) if (es[k].isIntersecting) { load(); io.disconnect(); } }, { rootMargin: '300px' });
      io.observe(wrap);
    } else load();
  }
})();

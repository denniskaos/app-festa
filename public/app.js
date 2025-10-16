// 1) “Tabela → cartões” no mobile: injeta data-label com o texto do <th>
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('table.table').forEach(table => {
    const heads = Array.from(table.querySelectorAll('thead th')).map(th => th.textContent.trim());
    table.querySelectorAll('tbody tr').forEach(tr => {
      Array.from(tr.children).forEach((td, i) => {
        td.setAttribute('data-label', heads[i] || '');
      });
    });
  });

  // 2) Toggle do menu (IDs do teu layout: #nav-toggle e #nav-menu)
  const btn = document.getElementById('nav-toggle');
  const nav = document.getElementById('nav-menu');
  if (btn && nav) {
    const close = () => {
      btn.setAttribute('aria-expanded', 'false');
      nav.classList.remove('open');
    };

    btn.addEventListener('click', () => {
      const open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', String(!open));
      nav.classList.toggle('open', !open); // precisa de .nav.open no CSS
    });

    // Fechar com ESC e ao voltar a desktop
    document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    window.addEventListener('resize', () => { if (window.innerWidth >= 900) close(); });
  }
});

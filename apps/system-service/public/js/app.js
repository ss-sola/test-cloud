(() => {
  if (typeof document === 'undefined') {
    return;
  }

  const overviewRoute = {
    title: '工作台总览',
    documentTitle: '工作台总览 · NestCloud',
  };

  const sidebar = document.querySelector('#sidebar');
  const sidebarScrim = document.querySelector('[data-sidebar-close]');
  const mobileMenuButton = document.querySelector('#mobile-menu-button');
  const breadcrumbCurrent = document.querySelector('#breadcrumb-current');
  const overviewView = document.querySelector('[data-view="overview"]');
  const overviewLink = document.querySelector('.nav-link[data-route="overview"]');

  if (
    !(sidebar instanceof HTMLElement) ||
    !(sidebarScrim instanceof HTMLElement) ||
    !(mobileMenuButton instanceof HTMLButtonElement) ||
    !(breadcrumbCurrent instanceof HTMLElement) ||
    !(overviewView instanceof HTMLElement) ||
    !(overviewLink instanceof HTMLAnchorElement)
  ) {
    return;
  }

  const setSidebarOpen = (open) => {
    sidebar.classList.toggle('is-open', open);
    sidebarScrim.classList.toggle('is-visible', open);
    mobileMenuButton.setAttribute('aria-expanded', String(open));
    mobileMenuButton.setAttribute('aria-label', open ? '关闭导航菜单' : '打开导航菜单');
  };

  const renderOverview = () => {
    overviewView.hidden = false;
    overviewLink.dataset.active = 'true';
    overviewLink.setAttribute('aria-current', 'page');
    breadcrumbCurrent.textContent = overviewRoute.title;
    document.title = overviewRoute.documentTitle;
    setSidebarOpen(false);
  };

  const normalizeRoute = () => {
    if (window.location.hash !== '#overview') {
      window.history.replaceState(null, '', '#overview');
    }
  };

  mobileMenuButton.addEventListener('click', () => {
    const isOpen = mobileMenuButton.getAttribute('aria-expanded') === 'true';
    setSidebarOpen(!isOpen);
  });

  sidebarScrim.addEventListener('click', () => setSidebarOpen(false));

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      setSidebarOpen(false);
    }
  });

  window.addEventListener('hashchange', () => {
    normalizeRoute();
    renderOverview();
  });

  normalizeRoute();
  renderOverview();
})();

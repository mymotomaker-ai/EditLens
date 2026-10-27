async function loadMenu() {
  const list = document.querySelector('.menu-list');
  const res = await fetch('/api/menu');
  if (!res.ok) {
    list.textContent = 'Menu unavailable right now.';
    return;
  }
  const items = await res.json();
  list.replaceChildren(
    ...items.map((item) => {
      const li = document.createElement('li');
      li.className = 'menu-item';
      const name = document.createElement('span');
      name.textContent = item.name;
      const price = document.createElement('span');
      price.className = 'price';
      const value = Number(item.price);
      price.textContent = Number.isFinite(value) ? `$${value.toFixed(2)}` : '—';
      li.append(name, price);
      return li;
    }),
  );
}

loadMenu().catch((err) => {
  console.error('Could not load the menu', err);
  document.querySelector('.menu-list').textContent = 'Menu unavailable right now.';
});

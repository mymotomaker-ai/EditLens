const stats = [
  { label: 'Active users', value: '12,480' },
  { label: 'Signups today', value: '312' },
  { label: 'Churn', value: '1.8%' },
];

export default function App() {
  return (
    <div className="app">
      <header className="topbar">
        <span className="logo">Orbit</span>
        <nav><a href="#">Overview</a><a href="#">Reports</a></nav>
      </header>
      <main className="content">
        <h1 className="page-title">Overview</h1>
        <div className="stats">
          {stats.map((s) => (
            <div className="stat-card" key={s.label}>
              <div className="stat-label">{s.label}</div>
              <div className="stat-value">{s.value}</div>
            </div>
          ))}
        </div>
        <section className="panel">
          <h2>Recent activity</h2>
          <p>No activity yet.</p>
        </section>
      </main>
    </div>
  );
}

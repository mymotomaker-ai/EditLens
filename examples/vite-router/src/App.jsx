import { Routes, Route, Link } from 'react-router-dom';
import Overview from './pages/Overview.jsx';
import Reports from './pages/Reports.jsx';
import Settings from './pages/Settings.jsx';

export default function App() {
  return (
    <div className="shell">
      <nav className="nav">
        <Link to="/">Overview</Link>
        <Link to="/reports">Reports</Link>
      </nav>
      <Routes>
        <Route path="/" element={<Overview />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </div>
  );
}

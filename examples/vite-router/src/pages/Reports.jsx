import { useState } from 'react';
import Customers from './Customers.jsx';
import './reports.css';

export default function Reports() {
  const [tab, setTab] = useState('summary');
  return (
    <main className="page">
      <h1>Reports</h1>
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'summary'} onClick={() => setTab('summary')}>Summary</button>
        <button type="button" role="tab" aria-selected={tab === 'customers'} onClick={() => setTab('customers')}>Customers</button>
      </div>
      {tab === 'summary' ? <p className="summary">Revenue increased 12%.</p> : <Customers />}
    </main>
  );
}

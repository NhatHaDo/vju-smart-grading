import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import Header from './Header';
import BottomNav from './BottomNav';

export default function AppShell() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      {/* VJU red top bar */}
      <Header />

      {/* Body: icon sidebar (desktop) + scrollable main */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <Sidebar />

        <main
          className="app-main"
          style={{
            flex: 1,
            overflowY: 'auto',
            background: '#F5F5F5',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <Outlet />
        </main>
      </div>

      {/* Bottom tab bar (mobile only, see globals.css) */}
      <BottomNav />
    </div>
  );
}

import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import AdminApp from './App';
import KioskApp from './kiosk/KioskApp';

const kiosk = location.pathname.startsWith('/kiosk');
document.title = kiosk ? 'Presently kiosk' : 'Presently';
createRoot(document.getElementById('root')!).render(<React.StrictMode>{kiosk ? <KioskApp /> : <AdminApp />}</React.StrictMode>);

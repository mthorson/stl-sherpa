import React from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider, createTheme } from '@mantine/core';
import { Notifications, notifications } from '@mantine/notifications';
import { App } from './App';

import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import './styles.css';

// Backstop for IPC calls without their own error handling: surface the
// failure instead of letting the user's action silently do nothing.
window.addEventListener('unhandledrejection', (event) => {
  const message =
    event.reason instanceof Error ? event.reason.message : String(event.reason ?? 'Unknown error');
  console.error('Unhandled rejection:', event.reason);
  notifications.show({
    color: 'red',
    title: 'Something went wrong',
    message,
    autoClose: 6000
  });
});

const theme = createTheme({
  primaryColor: 'indigo',
  defaultRadius: 'sm'
});

const container = document.getElementById('root');
if (!container) throw new Error('Root container missing');
createRoot(container).render(
  <React.StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <Notifications position="bottom-right" />
      <App />
    </MantineProvider>
  </React.StrictMode>
);

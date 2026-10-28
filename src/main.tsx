import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import AdminPortal from './AdminPortal'
import './index.css'

const Root = window.location.pathname === '/admin' ? AdminPortal : App

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
)

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => registration.update())
      .catch((error) => console.error('Unable to register the Perklyn service worker', error))
  })
}

import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import './styles/index.css'
import App from './pages/App.jsx'
import AdmissionForm from './pages/AdmissionForm.jsx'
import OtpVerify from './pages/OtpVerify.jsx'
import AdmissionSuccess from './pages/AdmissionSuccess.jsx'
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path='/' element={<App/>} />
        <Route path='/admission-form' element={<AdmissionForm/>} />
        <Route path='/admission-otp' element={<OtpVerify/>} />
        <Route path='/admission-success' element={<AdmissionSuccess/>} />
        <Route path='*' element={<div className='p-6'>Not found</div>} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
)

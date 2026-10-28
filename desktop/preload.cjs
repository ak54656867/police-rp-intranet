const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('desktopApp', Object.freeze({ platform: process.platform, version: '1.0.0' }));
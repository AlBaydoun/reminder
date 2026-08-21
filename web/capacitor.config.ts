import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The native shell.
 *
 * The phone build exists for one reason: a browser tab cannot ring. Everything
 * here is in service of an alarm that goes off when the app is closed, the
 * screen is locked and the phone is in someone's pocket.
 */
const config: CapacitorConfig = {
  appId: 'app.nexus.reminder',
  appName: 'Nexus',
  webDir: 'dist',

  // The web build is a real static bundle, so it is shipped inside the app
  // rather than loaded from a server. That is what makes the app work with no
  // connection — and an alarm that needs the network to ring is not an alarm.
  server: {
    androidScheme: 'https',
  },

  plugins: {
    LocalNotifications: {
      // Drawn white-on-transparent, which is what Android requires of a status
      // bar icon; a full-colour icon renders as a white square.
      smallIcon: 'ic_stat_nexus',
      iconColor: '#7C6BFF',
      // The default channel. Per-sound channels are created at runtime,
      // because Android binds a notification's sound to its channel and a
      // channel's sound cannot be changed after it is created.
      sound: 'nexus_chime.wav',
    },
    SplashScreen: {
      launchShowDuration: 600,
      backgroundColor: '#070711',
      showSpinner: false,
      androidSplashResourceName: 'splash',
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#070711',
      overlaysWebView: false,
    },
  },

  ios: {
    // The canvas needs every pointer event it can get; letting the WebView
    // treat a pencil drag as a scroll would break drawing.
    scrollEnabled: false,
    contentInset: 'never',
  },

  android: {
    // Alarms are the point, so the app asks for exact-alarm permission and
    // schedules against it rather than falling back to inexact windows.
    allowMixedContent: false,
  },
};

export default config;

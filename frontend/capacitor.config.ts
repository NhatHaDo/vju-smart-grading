import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'net.cunghoc.scoring',
  appName: 'VJU Chấm thi',
  webDir: 'dist',
  // App mở thẳng trang web đang chạy trên server — deploy web là app có bản mới
  server: {
    url: 'https://scoring.cunghoc.net',
    allowNavigation: ['scoring.cunghoc.net'],
  },
  // Trang bắt đầu dưới thanh giờ/pin và trên thanh vuốt về, không bị đè
  ios: {
    contentInset: 'always',
  },
  // Màu nền khung web trước khi trang tải xong — đỏ như màn hình chờ, để
  // màn hình chờ → hiệu ứng mở app (AppIntro) không bị nháy trắng ở giữa
  backgroundColor: '#AA2222',
};

export default config;
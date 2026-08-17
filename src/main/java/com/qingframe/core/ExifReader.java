package com.qingframe.core;

import java.io.*;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;

public class ExifReader {

    public static class ExifData {
        public String make = "";
        public String model = "";
        public String focalLength = "";
        public String aperture = "";
        public String iso = "";
        public String shutter = "";
        public String dateTime = "";
        /** EXIF 方向（1=正常，3=180，6=顺时针90，8=逆时针90） */
        public int orientation = 1;

        public String brand() {
            if (make == null || make.isEmpty()) return "";
            return CameraDatabase.getInstance().resolveBrand(make);
        }

        public String cleanModel() {
            if (model == null || model.isEmpty()) return "";
            String m = model.trim();
            int idx = m.indexOf("back camera");
            if (idx < 0) idx = m.indexOf("front camera");
            if (idx < 0) idx = m.indexOf("rear camera");
            if (idx > 0) m = m.substring(0, idx).trim();
            idx = m.indexOf("back");
            if (idx > 0) m = m.substring(0, idx).trim();
            // 型号保留 EXIF 原文格式（大小写/空格/连字符/下划线），只去掉重复的品牌前缀
            String b = brand();
            if (!b.isEmpty()) {
                String prefix = b + " ";
                if (m.toUpperCase().startsWith(prefix.toUpperCase())) {
                    m = m.substring(prefix.length()).trim();
                }
            }
            return m;
        }

        public boolean hasData() {
            boolean hasOptical = (focalLength != null && !focalLength.isEmpty())
                              || (aperture != null && !aperture.isEmpty())
                              || (iso != null && !iso.isEmpty())
                              || (shutter != null && !shutter.isEmpty());
            boolean hasId = (make != null && !make.isEmpty())
                         || (model != null && !model.isEmpty());
            return hasOptical || hasId;
        }
    }

    public static ExifData parse(File file) {
        if (file == null || !file.exists()) return null;
        String name = file.getName().toLowerCase();
        try {
            if (name.endsWith(".jpg") || name.endsWith(".jpeg"))
                return parseJpeg(file);
            return null;
        } catch (Exception e) {
            return null;
        }
    }

    private static ExifData parseJpeg(File file) throws IOException {
        byte[] data = readAllBytes(file);
        int exifStart = findExifMarker(data);
        if (exifStart < 0) return null;

        int tiffOff = exifStart + 2 + 6;
        if (tiffOff + 8 > data.length) return null;

        boolean le = (data[tiffOff] == 0x49 && data[tiffOff + 1] == 0x49);
        ByteOrder bo = le ? ByteOrder.LITTLE_ENDIAN : ByteOrder.BIG_ENDIAN;

        int ifd0Off = bytesToInt(data, tiffOff + 4, 4, bo);
        if (ifd0Off <= 0 || tiffOff + ifd0Off + 2 > data.length) return null;

        ExifData exif = new ExifData();
        parseIFD(data, tiffOff + ifd0Off, bo, tiffOff, exif);
        return exif;
    }

    private static int findExifMarker(byte[] data) {
        for (int i = 0; i < data.length - 6; i++) {
            if (data[i] == 0x45 && data[i + 1] == 0x78
                    && data[i + 2] == 0x69 && data[i + 3] == 0x66
                    && data[i + 4] == 0x00 && data[i + 5] == 0x00) {
                int lenStart = i - 2;
                if (lenStart >= 0) return lenStart;
            }
        }
        return -1;
    }

    private static void parseIFD(byte[] data, int ifdStart, ByteOrder bo, int tiffOff, ExifData exif) {
        int entryCount = bytesToInt(data, ifdStart, 2, bo);
        if (entryCount <= 0 || entryCount > 100) return;

        int exifIFDOffset = -1;

        for (int i = 0; i < entryCount; i++) {
            int entryOff = ifdStart + 2 + i * 12;
            if (entryOff + 12 > data.length) break;

            int tag = bytesToInt(data, entryOff, 2, bo);
            int type = bytesToInt(data, entryOff + 2, 2, bo);
            int count = bytesToInt(data, entryOff + 4, 4, bo);
            int valueOff = entryOff + 8;

            switch (tag) {
                case 0x010F:
                    exif.make = readASCII(data, valueOff, count, bo, tiffOff);
                    break;
                case 0x0110:
                    exif.model = readASCII(data, valueOff, count, bo, tiffOff);
                    break;
                case 0x0112:
                    exif.orientation = bytesToInt(data, valueOff, 2, bo);
                    if (exif.orientation < 1 || exif.orientation > 8) exif.orientation = 1;
                    break;
                case 0x9003:
                case 0x9004:
                    if (exif.dateTime.isEmpty())
                        exif.dateTime = readASCII(data, valueOff, count, bo, tiffOff);
                    break;
                case 0x8769:
                    exifIFDOffset = bytesToInt(data, valueOff, 4, bo);
                    break;
            }
        }

        if (exifIFDOffset > 0) {
            parseSubIFD(data, tiffOff + exifIFDOffset, bo, tiffOff, exif);
        }
    }

    private static void parseSubIFD(byte[] data, int ifdStart, ByteOrder bo, int tiffOff, ExifData exif) {
        int entryCount = bytesToInt(data, ifdStart, 2, bo);
        if (entryCount <= 0 || entryCount > 100) return;

        for (int i = 0; i < entryCount; i++) {
            int entryOff = ifdStart + 2 + i * 12;
            if (entryOff + 12 > data.length) break;

            int tag = bytesToInt(data, entryOff, 2, bo);
            int type = bytesToInt(data, entryOff + 2, 2, bo);
            int count = bytesToInt(data, entryOff + 4, 4, bo);
            int valueOff = entryOff + 8;

            switch (tag) {
                case 0x829D:
                    if (type == 5) {
                        long[] rat = readRational(data, valueOff, bo, tiffOff);
                        if (rat != null && rat[1] != 0) {
                            double val = (double) rat[0] / rat[1];
                            exif.aperture = String.format("f/%.1f", val);
                        }
                    }
                    break;
                case 0x829A:
                    if (type == 5) {
                        long[] rat = readRational(data, valueOff, bo, tiffOff);
                        if (rat != null && rat[1] != 0) {
                            exif.shutter = formatShutter((double) rat[0] / rat[1]);
                        }
                    }
                    break;
                case 0x8827:
                    if (type == 3 && count == 1) {
                        int v = bytesToInt(data, valueOff, 2, bo);
                        exif.iso = "ISO " + v;
                    } else if (type == 4 && count == 1) {
                        int v = bytesToInt(data, valueOff, 4, bo);
                        exif.iso = "ISO " + v;
                    } else if (type == 3 && count > 1) {
                        // type=3 且 count>1 时 4 字节值字段存的是数据偏移量，需从 TIFF 偏移处读取首个值
                        int off = bytesToInt(data, valueOff, 4, bo);
                        if (off >= 0 && tiffOff + off + 2 <= data.length) {
                            exif.iso = "ISO " + bytesToInt(data, tiffOff + off, 2, bo);
                        }
                    }
                    break;
                case 0x920A:
                    if (type == 5) {
                        long[] rat = readRational(data, valueOff, bo, tiffOff);
                        if (rat != null && rat[1] != 0) {
                            double val = (double) rat[0] / rat[1];
                            exif.focalLength = String.format("%.0fmm", val);
                        }
                    }
                    break;
            }
        }
    }

    private static String formatShutter(double seconds) {
        if (seconds <= 0) return "1/125";
        if (seconds >= 1.0) {
            return String.format("%.0f", seconds);
        }
        int den = (int) Math.round(1.0 / seconds);
        return "1/" + den;
    }

    private static String readASCII(byte[] data, int valueOff, int count, ByteOrder bo, int tiffOff) {
        String raw;
        if (count <= 4) {
            int len = Math.min(count, data.length - valueOff);
            raw = new String(data, valueOff, len, StandardCharsets.US_ASCII);
        } else {
            int offset = bytesToInt(data, valueOff, 4, bo);
            if (offset < 0 || tiffOff + offset >= data.length) return "";
            int len = Math.min(count, data.length - tiffOff - offset);
            if (len <= 0) return "";
            raw = new String(data, tiffOff + offset, len, StandardCharsets.US_ASCII);
        }
        int nullIdx = raw.indexOf(0);
        if (nullIdx >= 0) raw = raw.substring(0, nullIdx);
        return raw.trim();
    }

    private static long[] readRational(byte[] data, int valueOff, ByteOrder bo, int tiffOff) {
        int offset = bytesToInt(data, valueOff, 4, bo);
        if (offset < 0 || tiffOff + offset + 8 > data.length) return null;
        long num = bytesToInt(data, tiffOff + offset, 4, bo) & 0xFFFFFFFFL;
        long den = bytesToInt(data, tiffOff + offset + 4, 4, bo) & 0xFFFFFFFFL;
        return new long[]{num, den};
    }

    private static int bytesToInt(byte[] data, int off, int len, ByteOrder bo) {
        if (off < 0 || off + len > data.length) return 0;
        if (len == 1) return data[off] & 0xFF;
        if (len == 2) {
            return bo == ByteOrder.LITTLE_ENDIAN
                    ? (data[off] & 0xFF) | ((data[off + 1] & 0xFF) << 8)
                    : ((data[off] & 0xFF) << 8) | (data[off + 1] & 0xFF);
        }
        if (len == 4) {
            return bo == ByteOrder.LITTLE_ENDIAN
                    ? (data[off] & 0xFF) | ((data[off + 1] & 0xFF) << 8)
                    | ((data[off + 2] & 0xFF) << 16) | ((data[off + 3] & 0xFF) << 24)
                    : ((data[off] & 0xFF) << 24) | ((data[off + 1] & 0xFF) << 16)
                    | ((data[off + 2] & 0xFF) << 8) | (data[off + 3] & 0xFF);
        }
        return 0;
    }

    private static byte[] readAllBytes(File file) throws IOException {
        long len = file.length();
        if (len > 50_000_000) throw new IOException("file too large");
        try (FileInputStream fis = new FileInputStream(file);
             ByteArrayOutputStream baos = new ByteArrayOutputStream((int) len)) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = fis.read(buf)) != -1) baos.write(buf, 0, n);
            return baos.toByteArray();
        }
    }
}

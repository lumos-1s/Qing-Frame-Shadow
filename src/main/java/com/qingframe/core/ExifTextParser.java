package com.qingframe.core;

import com.drew.imaging.ImageMetadataReader;
import com.drew.metadata.Directory;
import com.drew.metadata.Metadata;
import com.drew.metadata.exif.ExifIFD0Directory;
import com.drew.metadata.exif.ExifSubIFDDirectory;

import java.io.File;
import java.util.LinkedHashMap;
import java.util.Map;

public class ExifTextParser {

    private static final int TAG_FNUMBER = 0x829D;
    private static final int TAG_EXPOSURE_TIME = 0x829A;
    private static final int TAG_ISO = 0x8827;
    private static final int TAG_FOCAL_LENGTH = 0x920A;
    private static final int TAG_DATETIME_ORIGINAL = 0x9003;
    private static final int TAG_EXPOSURE_COMPENSATION = 0x9204;
    private static final int TAG_MAKE = 0x010F;
    private static final int TAG_MODEL = 0x0110;

    public static Map<String, String> readExif(String imagePath) {
        Map<String, String> exifData = new LinkedHashMap<>();
        try {
            File file = new File(imagePath);
            if (!file.exists()) return exifData;

            Metadata metadata = ImageMetadataReader.readMetadata(file);

            Directory exifSub = metadata.getFirstDirectoryOfType(ExifSubIFDDirectory.class);
            if (exifSub != null) {
                putIf(exifData, exifSub, "光圈", TAG_FNUMBER, "F/");
                putIf(exifData, exifSub, "快门", TAG_EXPOSURE_TIME, "s");
                putIf(exifData, exifSub, "ISO", TAG_ISO, "");
                putIf(exifData, exifSub, "焦距", TAG_FOCAL_LENGTH, "mm");
                putIf(exifData, exifSub, "日期", TAG_DATETIME_ORIGINAL, "");
                putIf(exifData, exifSub, "曝光补偿", TAG_EXPOSURE_COMPENSATION, "EV");
            }

            Directory ifd0 = metadata.getFirstDirectoryOfType(ExifIFD0Directory.class);
            if (ifd0 != null) {
                putIf(exifData, ifd0, "相机", TAG_MAKE, "");
                if (ifd0.containsTag(TAG_MODEL)) {
                    String modelRaw = ifd0.getString(TAG_MODEL);
                    if (modelRaw != null && !modelRaw.isEmpty()) {
                        // 型号经品牌库规范化为俗称（如 ILCE-7M4 → A7M4），与相机参数区显示一致
                        String brandId = CameraDatabase.getInstance().resolveBrand(exifData.get("相机"));
                        exifData.put("镜头", CameraDatabase.getInstance().resolveModel(brandId, modelRaw));
                    }
                }
            }

        } catch (Exception e) {
            System.err.println("[ExifTextParser] EXIF 信息解析失败: " + e.getMessage());
        }

        return exifData;
    }

    private static void putIf(Map<String, String> map, Directory dir, String label, int tag, String suffix) {
        if (dir.containsTag(tag)) {
            String value = dir.getString(tag);
            if (value != null && !value.isEmpty()) {
                map.put(label, value + suffix);
            }
        }
    }

    public static String formatExifText(Map<String, String> exif, String format) {
        StringBuilder sb = new StringBuilder();
        if (exif.containsKey("相机") && exif.containsKey("镜头")) {
            sb.append(exif.get("相机")).append(" ").append(exif.get("镜头")).append("  ");
        }
        if (exif.containsKey("光圈")) sb.append(exif.get("光圈")).append("  ");
        if (exif.containsKey("快门")) sb.append(exif.get("快门")).append("  ");
        if (exif.containsKey("ISO")) sb.append("ISO ").append(exif.get("ISO")).append("  ");
        if (exif.containsKey("焦距")) sb.append(exif.get("焦距")).append("  ");
        if (exif.containsKey("日期")) sb.append(exif.get("日期"));
        return sb.toString().trim();
    }
}

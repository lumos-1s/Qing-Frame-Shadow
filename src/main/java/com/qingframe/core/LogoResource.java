package com.qingframe.core;

import java.awt.*;

public class LogoResource {

    private LogoResource() {}

    public static void draw(Graphics2D g, String brand, int x, int y, Font font) {
        if (brand == null) brand = "CAMERA";
        int fs = font.getSize();
        switch (brand.toUpperCase()) {
            case "LEICA" -> drawLeica(g, x, y, font, fs);
            case "CANON" -> drawCanon(g, x, y, font);
            case "NIKON" -> drawNikon(g, x, y, font, fs);
            case "FUJIFILM" -> drawFujifilm(g, x, y, font, fs);
            case "SONY" -> drawSony(g, x, y, font);
            case "HASSELBLAD" -> drawHasselblad(g, x, y, font, fs);
            case "LUMIX", "PANASONIC" -> drawLumix(g, x, y, font, fs);
            case "OLYMPUS" -> drawOlympus(g, x, y, font);
            case "PENTAX" -> drawPentax(g, x, y, font);
            case "RICOH" -> drawRicoh(g, x, y, font);
            case "ZEISS" -> drawZeiss(g, x, y, font, fs);
            case "DJI" -> drawDJI(g, x, y, font, fs);
            case "APPLE" -> drawApple(g, x, y, font);
            case "HONOR" -> drawHonor(g, x, y, font);
            case "HUAWEI" -> drawHuawei(g, x, y, font);
            case "OPPO" -> drawOppo(g, x, y, font);
            case "SAMSUNG" -> drawSamsung(g, x, y, font);
            case "VIVO" -> drawVivo(g, x, y, font);
            case "MI", "XIAOMI" -> drawXiaomi(g, x, y, font);
            case "SIGMA" -> drawSigma(g, x, y, font);
            case "TAMRON" -> drawTamron(g, x, y, font, fs);
            case "GOPRO" -> drawGoPro(g, x, y, font);
            case "INSTA360" -> drawInsta360(g, x, y, font);
            case "RED" -> drawRed(g, x, y, font);
            case "BLACKMAGIC" -> drawBlackmagic(g, x, y, font);
            case "KODAK" -> drawKodak(g, x, y, font);
            case "POLAROID" -> drawPolaroid(g, x, y, font, fs);
            case "PHASE ONE", "PHASEONE" -> drawPhaseOne(g, x, y, font);
            case "MAMIYA" -> drawMamiya(g, x, y, font);
            case "CASIO" -> drawCasio(g, x, y, font);
            case "AGFA" -> drawAgfa(g, x, y, font);
            case "REDMI" -> drawRedmi(g, x, y, font);
            case "REALME" -> drawRealme(g, x, y, font);
            case "ONEPLUS" -> drawOnePlus(g, x, y, font);
            case "IQOO" -> drawIqoo(g, x, y, font);
            case "GOOGLE" -> drawGoogle(g, x, y, font);
            case "NOTHING" -> drawNothing(g, x, y, font);
            case "MOTOROLA" -> drawMotorola(g, x, y, font);
            case "NOKIA" -> drawNokia(g, x, y, font);
            case "MEIZU" -> drawMeizu(g, x, y, font);
            case "ZTE" -> drawZte(g, x, y, font);
            case "ASUS" -> drawAsus(g, x, y, font);
            case "LG" -> drawLg(g, x, y, font);
            case "HTC" -> drawHtc(g, x, y, font);
            case "TECNO" -> drawTecno(g, x, y, font);
            case "INFINIX" -> drawInfinix(g, x, y, font);
            case "LENOVO" -> drawLenovo(g, x, y, font);
            case "ROLLEI" -> drawRollei(g, x, y, font);
            case "CONTAX" -> drawContax(g, x, y, font);
            case "VOIGTLANDER", "VOIGTLÄNDER" -> drawVoigtlander(g, x, y, font);
            case "HORSEMAN" -> drawHorseman(g, x, y, font);
            case "LINHOF" -> drawLinhof(g, x, y, font);
            case "TOYO" -> drawToyo(g, x, y, font);
            case "SEAGULL" -> drawSeagull(g, x, y, font);
            case "LOMO" -> drawLomo(g, x, y, font);
            case "ALPA" -> drawAlpa(g, x, y, font);
            case "NUBIA" -> drawNubia(g, x, y, font);
            case "REDMAGIC" -> drawRedmagic(g, x, y, font);
            case "BLACKSHARK" -> drawBlackshark(g, x, y, font);
            case "ITEL" -> drawItel(g, x, y, font);
            case "DOOGEE" -> drawDoogee(g, x, y, font);
            case "ULEFONE" -> drawUlefone(g, x, y, font);
            case "CAT" -> drawCat(g, x, y, font);
            case "VERTU" -> drawVertu(g, x, y, font);
            case "CAMERA" -> drawCamera(g, x, y, font);
            default -> drawGeneric(g, brand, x, y, font);
        }
    }

    public static int width(String brand, Font font) {
        if (brand == null) brand = "CAMERA";
        int fs = font.getSize();
        return switch (brand.toUpperCase()) {
            case "LEICA" -> fs * 5;
            case "CANON" -> fs * 4;
            case "NIKON" -> fs * 4;
            case "FUJIFILM" -> fs * 7;
            case "SONY" -> fs * 4;
            case "HASSELBLAD" -> fs * 8;
            case "LUMIX", "PANASONIC" -> fs * 5;
            case "OLYMPUS" -> fs * 6;
            case "PENTAX" -> fs * 5;
            case "RICOH" -> fs * 4;
            case "ZEISS" -> fs * 4;
            case "DJI" -> fs * 3;
            case "APPLE" -> fs * 4;
            case "HONOR" -> fs * 4;
            case "HUAWEI" -> fs * 5;
            case "OPPO" -> fs * 4;
            case "SAMSUNG" -> fs * 6;
            case "VIVO" -> fs * 4;
            case "MI", "XIAOMI" -> fs * 3;
            case "CAMERA" -> fs * 5;
            default -> fs * Math.min(brand.length(), 8);
        };
    }

    private static void drawLeica(Graphics2D g, int x, int y, Font font, int fs) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(200, 30, 30));
        int dotR = fs / 3;
        g.fillOval(x, y - dotR, dotR * 2, dotR * 2);
        g.setColor(Color.BLACK);
        int textX = x + dotR * 3 + fs / 3;
        g.drawString("LEICA", textX, y);
    }

    private static void drawCanon(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.ITALIC | Font.BOLD));
        g.setColor(new Color(200, 30, 30));
        g.drawString("Canon", x, y);
    }

    private static void drawNikon(Graphics2D g, int x, int y, Font font, int fs) {
        int barW = fs * 4;
        int barH = fs * 7 / 10;
        g.setColor(new Color(255, 200, 0));
        g.fillRoundRect(x, y - barH, barW, barH, fs / 5, fs / 5);
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(Color.BLACK);
        g.drawString("NIKON", x + fs / 3, y - fs / 8);
    }

    private static void drawFujifilm(Graphics2D g, int x, int y, Font font, int fs) {
        int w = fs * 7;
        int h = fs * 11 / 12;
        g.setColor(new Color(40, 120, 60));
        g.fillRoundRect(x, y - h + fs / 4, w, h, fs / 4, fs / 4);
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(Color.WHITE);
        g.drawString("FUJIFILM", x + fs / 3, y + fs / 8);
    }

    private static void drawSony(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(0, 80, 160));
        g.drawString("SONY", x, y);
    }

    private static void drawHasselblad(Graphics2D g, int x, int y, Font font, int fs) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(Color.BLACK);
        g.drawString("HASSELBLAD", x, y);
        g.setColor(new Color(180, 0, 0));
        g.fillRect(x + fs / 2, y + fs / 6, fs * 2, fs / 10);
    }

    private static void drawLumix(Graphics2D g, int x, int y, Font font, int fs) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(Color.BLACK);
        g.drawString("LUMIX", x, y);
        g.setColor(new Color(0, 120, 200));
        int tw = g.getFontMetrics().stringWidth("LUMIX");
        g.fillRect(x + tw + fs / 4, y - fs / 4, fs * 3 / 4, fs / 6);
    }

    private static void drawOlympus(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(Color.BLACK);
        g.drawString("OLYMPUS", x, y);
    }

    private static void drawPentax(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(0, 60, 120));
        g.drawString("PENTAX", x, y);
    }

    private static void drawRicoh(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(0, 80, 160));
        g.drawString("RICOH", x, y);
    }

    private static void drawZeiss(Graphics2D g, int x, int y, Font font, int fs) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(0, 60, 180));
        g.drawString("ZEISS", x, y);
        g.setColor(new Color(0, 60, 180, 50));
        g.drawOval(x - fs / 4, y - fs * 11 / 12, fs * 11 / 10, fs * 3 / 2);
    }

    private static void drawDJI(Graphics2D g, int x, int y, Font font, int fs) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(Color.BLACK);
        g.drawString("DJI", x, y);
        g.setColor(new Color(200, 30, 30));
        int dotR = fs / 5;
        int tw = g.getFontMetrics().stringWidth("DJI");
        g.fillOval(x + tw + fs / 3, y - dotR, dotR * 2, dotR * 2);
    }

    private static void drawApple(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.PLAIN));
        g.setColor(new Color(80, 80, 80));
        g.drawString("iPhone", x, y);
    }

    private static void drawHonor(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(Color.BLACK);
        g.drawString("HONOR", x, y);
    }

    private static void drawHuawei(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(200, 30, 30));
        g.drawString("HUAWEI", x, y);
    }

    private static void drawOppo(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(80, 80, 80));
        g.drawString("OPPO", x, y);
    }

    private static void drawSamsung(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(0, 100, 200));
        g.drawString("SAMSUNG", x, y);
    }

    private static void drawVivo(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(0, 80, 200));
        g.drawString("vivo", x, y);
    }

    private static void drawXiaomi(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(255, 100, 0));
        g.drawString("MI", x, y);
    }

    // ═══════════════ 新增相机品牌 ═══════════════

    private static void drawSigma(Graphics2D g, int x, int y, Font font) {
        int fs = font.getSize();
        g.setColor(new Color(190, 30, 45));
        g.fillPolygon(new int[]{x, x + fs / 2, x}, new int[]{y - fs * 3 / 4, y, y + fs * 3 / 4}, 3);
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(Color.BLACK);
        g.drawString("SIGMA", x + fs * 3 / 4, y);
    }

    private static void drawTamron(Graphics2D g, int x, int y, Font font, int fs) {
        g.setColor(new Color(0, 90, 170));
        g.drawOval(x, y - fs / 2, fs * 3 / 4, fs * 3 / 4);
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(Color.BLACK);
        g.drawString("TAMRON", x + fs, y);
    }

    private static void drawGoPro(Graphics2D g, int x, int y, Font font) {
        int fs = font.getSize();
        g.setColor(Color.BLACK);
        g.fillRoundRect(x, y - fs * 3 / 4, fs * 3, fs * 3 / 2, fs / 4, fs / 4);
        g.setFont(font.deriveFont(Font.BOLD, fs * 3 / 4));
        g.setColor(Color.WHITE);
        g.drawString("GoPro", x + fs / 4, y + fs / 8);
    }

    private static void drawInsta360(Graphics2D g, int x, int y, Font font) {
        int fs = font.getSize();
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(Color.BLACK);
        g.drawString("INSTA360", x, y);
        g.setColor(new Color(220, 30, 40));
        int tw = g.getFontMetrics().stringWidth("INSTA360");
        g.fillOval(x + tw + fs / 3, y - fs / 6, fs / 3, fs / 3);
    }

    private static void drawRed(Graphics2D g, int x, int y, Font font) {
        int fs = font.getSize();
        g.setColor(new Color(200, 20, 25));
        g.fillRect(x, y - fs * 3 / 4, fs * 2, fs * 3 / 2);
        g.setFont(font.deriveFont(Font.BOLD, fs * 3 / 4));
        g.setColor(Color.WHITE);
        g.drawString("RED", x + fs / 4, y + fs / 8);
    }

    private static void drawBlackmagic(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(10, 10, 10));
        g.drawString("Blackmagic", x, y);
    }

    private static void drawKodak(Graphics2D g, int x, int y, Font font) {
        int fs = font.getSize();
        g.setColor(new Color(240, 200, 0));
        g.fillRect(x, y - fs * 3 / 4, fs * 3, fs * 3 / 2);
        g.setFont(font.deriveFont(Font.BOLD, fs * 3 / 4));
        g.setColor(new Color(190, 25, 30));
        g.drawString("KODAK", x + fs / 4, y + fs / 8);
    }

    private static void drawPolaroid(Graphics2D g, int x, int y, Font font, int fs) {
        int bw = fs * 3;
        int h = fs / 5;
        int y0 = y - fs * 3 / 4;
        Color[] rainbow = {new Color(230, 60, 50), new Color(245, 170, 40), new Color(240, 220, 60),
                new Color(80, 180, 80), new Color(70, 150, 220), new Color(140, 90, 200)};
        for (int i = 0; i < rainbow.length; i++) {
            g.setColor(rainbow[i]);
            g.fillRect(x + i * bw / rainbow.length, y0 + i * h / 2, bw / rainbow.length + 1, h);
        }
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(Color.BLACK);
        g.drawString("Polaroid", x + fs / 6, y + fs / 6);
    }

    private static void drawPhaseOne(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(Color.BLACK);
        g.drawString("Phase One", x, y);
    }

    private static void drawMamiya(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(30, 30, 30));
        g.drawString("MAMIYA", x, y);
    }

    private static void drawCasio(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD | Font.ITALIC));
        g.setColor(new Color(0, 90, 190));
        g.drawString("CASIO", x, y);
    }

    private static void drawAgfa(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(190, 25, 30));
        g.drawString("AGFA", x, y);
    }

    // ═══════════════ 新增手机品牌 ═══════════════

    private static void drawRedmi(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(255, 100, 0));
        g.drawString("Redmi", x, y);
    }

    private static void drawRealme(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(240, 190, 30));
        g.drawString("realme", x, y);
    }

    private static void drawOnePlus(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(200, 20, 20));
        g.drawString("OnePlus", x, y);
        int fs = font.getSize();
        int tw = g.getFontMetrics().stringWidth("OnePlus");
        g.setStroke(new BasicStroke(fs / 8));
        g.drawLine(x + tw + fs / 3, y - fs / 3, x + tw + fs * 4 / 3, y + fs / 3);
        g.drawLine(x + tw + fs / 3, y + fs / 3, x + tw + fs * 4 / 3, y - fs / 3);
    }

    private static void drawIqoo(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(0, 100, 220));
        g.drawString("iQOO", x, y);
    }

    private static void drawGoogle(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(60, 90, 200));
        g.drawString("Google", x, y);
    }

    private static void drawNothing(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.PLAIN));
        g.setColor(new Color(20, 20, 20));
        g.drawString("Nothing", x, y);
    }

    private static void drawMotorola(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(25, 25, 25));
        g.drawString("MOTOROLA", x, y);
    }

    private static void drawNokia(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(0, 90, 200));
        g.drawString("NOKIA", x, y);
    }

    private static void drawMeizu(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(0, 90, 200));
        g.drawString("MEIZU", x, y);
    }

    private static void drawZte(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(0, 110, 190));
        g.drawString("ZTE", x, y);
    }

    private static void drawAsus(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(0, 90, 190));
        g.drawString("ASUS", x, y);
    }

    private static void drawLg(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(90, 90, 90));
        g.drawString("LG", x, y);
    }

    private static void drawHtc(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(0, 140, 90));
        g.drawString("HTC", x, y);
    }

    private static void drawTecno(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(25, 25, 25));
        g.drawString("TECNO", x, y);
    }

    private static void drawInfinix(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(0, 150, 170));
        g.drawString("Infinix", x, y);
    }

    private static void drawLenovo(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(0, 100, 190));
        g.drawString("Lenovo", x, y);
    }

    // ═══════════════ 扩充品牌 ═══════════════

    private static void drawRollei(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(180, 25, 30));
        g.drawString("ROLLEIFLEX", x, y);
    }

    private static void drawContax(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(40, 40, 40));
        g.drawString("CONTAX", x, y);
        int fs = font.getSize();
        int tw = g.getFontMetrics().stringWidth("CONTAX");
        g.setColor(new Color(200, 30, 30));
        g.fillRect(x + tw + fs / 4, y - fs / 4, fs * 3 / 4, fs / 6);
    }

    private static void drawVoigtlander(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(30, 30, 30));
        g.drawString("Voigtländer", x, y);
    }

    private static void drawHorseman(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(25, 25, 25));
        g.drawString("HORSEMAN", x, y);
    }

    private static void drawLinhof(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(20, 20, 20));
        g.drawString("LINHOF", x, y);
    }

    private static void drawToyo(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(0, 90, 170));
        g.drawString("TOYO", x, y);
    }

    private static void drawSeagull(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(200, 25, 30));
        g.drawString("SEAGULL", x, y);
    }

    private static void drawLomo(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(0, 90, 200));
        g.drawString("LOMO", x, y);
    }

    private static void drawAlpa(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(25, 25, 25));
        g.drawString("ALPA", x, y);
    }

    private static void drawNubia(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(200, 20, 20));
        g.drawString("nubia", x, y);
    }

    private static void drawRedmagic(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(200, 15, 25));
        g.drawString("REDMAGIC", x, y);
    }

    private static void drawBlackshark(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(25, 25, 25));
        g.drawString("BLACK SHARK", x, y);
    }

    private static void drawItel(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(0, 100, 200));
        g.drawString("itel", x, y);
    }

    private static void drawDoogee(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(0, 120, 210));
        g.drawString("DOOGEE", x, y);
    }

    private static void drawUlefone(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(0, 110, 190));
        g.drawString("Ulefone", x, y);
    }

    private static void drawCat(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(245, 170, 0));
        g.drawString("CAT", x, y);
    }

    private static void drawVertu(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(150, 110, 50));
        g.drawString("VERTU", x, y);
    }

    private static void drawCamera(Graphics2D g, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(120, 120, 120));
        g.drawString("CAMERA", x, y);
    }

    private static void drawGeneric(Graphics2D g, String brand, int x, int y, Font font) {
        g.setFont(font.deriveFont(Font.BOLD));
        g.setColor(new Color(80, 80, 80));
        g.drawString(brand.length() > 10 ? brand.substring(0, 10) : brand, x, y);
    }
}

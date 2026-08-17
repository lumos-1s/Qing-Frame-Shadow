package com.qingframe.server.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.stereotype.Service;

/** 邮件发送：忘记密码验证码。未配置 SMTP 时返回 false（由调用方降级为日志/响应返回） */
@Service
public class MailService {

    private static final Logger log = LoggerFactory.getLogger(MailService.class);

    private final JavaMailSender mailSender;
    private final String from;

    public MailService(JavaMailSender mailSender,
                       @Value("${spring.mail.username:}") String from) {
        this.mailSender = mailSender;
        this.from = from;
    }

    /** 发送验证码邮件；未配置 SMTP 或发送失败返回 false */
    public boolean sendResetCode(String to, String code) {
        if (from == null || from.isEmpty()) {
            // 不打印验证码明文：日志泄露等于验证码泄露
            log.warn("[mail] 未配置 spring.mail.username，验证码邮件未发送");
            return false;
        }
        try {
            SimpleMailMessage msg = new SimpleMailMessage();
            msg.setFrom(from);
            msg.setTo(to);
            msg.setSubject("清框影 - 密码重置验证码");
            msg.setText("您的密码重置验证码是：" + code + "，10 分钟内有效。"
                    + "若非本人操作，请忽略本邮件。");
            mailSender.send(msg);
            return true;
        } catch (Exception e) {
            log.warn("[mail] 验证码邮件发送失败: {}", e.getMessage());
            return false;
        }
    }
}

package com.qingframe.server.mapper;

import com.qingframe.server.entity.PasswordReset;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface PasswordResetMapper {

    int insert(PasswordReset pr);

    /** 取该邮箱最新一条验证码记录 */
    PasswordReset findLatestByEmail(@Param("email") String email);

    int markUsed(@Param("id") Long id);
}

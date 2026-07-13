# GDC DSR™ 服务器网络控制协议 v2.2

**版本**: 2.2 (实际版本)  
**适用于**: GDC DSR 系列服务器  
**文档日期**: 2025年11月  
**协议端口**: TCP 49153

---

## 目录

- [1. 概述](#1-概述)
- [2. 连接](#2-连接)
- [3. 命令格式](#3-命令格式)
  - [3.1 命令结构](#31-命令结构)
  - [3.2 响应结构](#32-响应结构)
  - [3.3 错误处理](#33-错误处理)
- [4. 命令参考](#4-命令参考)
  - [4.1 基础命令](#41-基础命令)
  - [4.2 CPL管理](#42-cpl管理)
  - [4.3 KDM管理](#43-kdm管理)
  - [4.4 放映列表管理(SHOW)](#44-放映列表管理show)
  - [4.5 排期管理](#45-排期管理)
  - [4.6 播放控制](#46-播放控制)
  - [4.7 内容摄取](#47-内容摄取)
  - [4.8 内容删除](#48-内容删除)
  - [4.9 服务器信息](#49-服务器信息)
  - [4.10 资产管理](#410-资产管理)
  - [4.11 日志管理](#411-日志管理)
  - [4.12 直播源管理](#412-直播源管理)
  - [4.13 自动化控制](#413-自动化控制)
  - [4.14 系统文件](#414-系统文件)
  - [4.15 IMOP功能](#415-imop功能)
- [5. 附录](#5-附录)
  - [5.1 数据格式说明](#51-数据格式说明)
  - [5.2 支持的命令列表](#52-支持的命令列表)
  - [5.3 错误代码](#53-错误代码)

---

## 1. 概述

本文档描述了通过网络连接控制 GDC DSR 系列数字电影服务器所使用的协议。该协议基于 TCP/IP 通信，使用 XML 格式的命令和响应。

### 1.1 协议特性

- **传输协议**: TCP/IP
- **默认端口**: 49153
- **数据格式**: XML
- **编码支持**: ASCII (默认), UTF-8 (可配置)
- **通信模式**: 命令-响应（同步）

### 1.2 版本信息

- 协议版本: 2.2
- 支持的服务器型号: DSR 系列
- API 命令数量: 76+

---

## 2. 连接

### 2.1 建立连接

服务器在 TCP 端口 **49153** 上监听传入连接。客户端需要主动连接到服务器。
```
客户端 ----[TCP SYN]----> 服务器:49153
客户端 <---[TCP SYN-ACK]- 服务器
客户端 ----[TCP ACK]----> 服务器
```

### 2.2 通信机制

- 采用**命令-响应握手**机制
- 客户端发送命令后必须等待服务器响应
- 同一连接上同时只能有一个未完成的命令
- 每个命令都必须收到完整响应后才能发送下一个命令

### 2.3 连接管理

- 不建议使用多个并发客户端连接
- 超时时间建议设置为 10-30 秒

---

## 3. 命令格式

### 3.1 命令结构

每个命令由以下部分组成：

| 部分 | 大小 | 描述 |
|------|------|------|
| **命令头** | 16 字节 | 固定值: `0x060E2B34 0x02050101 0x0F150110 0x00000000` |
| **长度字段** | 4 字节 | XML 数据长度，BER 长格式编码 |
| **XML 数据** | 可变 | XML 格式的命令内容 |

#### 3.1.1 命令头
```
十六进制: 06 0E 2B 34 02 05 01 01 0F 15 01 10 00 00 00 00
```

#### 3.1.2 长度编码

采用 BER (Basic Encoding Rules) 长格式：
- 第 1 字节: `0x83` (表示后续 3 字节为长度)
- 第 2-4 字节: 长度值（大端序）

示例：
```
长度 = 120 字节
编码 = 0x83 0x00 0x00 0x78
```

#### 3.1.3 XML 命令格式
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="COMMAND_NAME">
  <param1>value1</param1>
  <param2>value2</param2>
  <!-- 更多参数 -->
</command>
```

**属性说明:**
- `version`: 协议版本，固定为 "2.2"
- `cmd`: 命令名称（大写）

### 3.2 响应结构

每个响应由以下部分组成：

| 部分 | 大小 | 描述 |
|------|------|------|
| **响应头** | 16 字节 | 固定值: `0x060E2B34 0x02050101 0x0F150111 0x00000000` |
| **长度字段** | 4 字节 | XML 数据长度，BER 长格式编码 |
| **XML 数据** | 可变 | XML 格式的响应内容 |

#### 3.2.1 响应头
```
十六进制: 06 0E 2B 34 02 05 01 01 0F 15 01 11 00 00 00 00
```

注意：响应头与命令头的差异仅在第 15 字节（0x11 vs 0x10）

#### 3.2.2 成功响应
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2">
  <!-- 返回的数据 -->
</response>
```

#### 3.2.3 错误响应
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="ERROR" version="2.2">
  <error>错误消息描述</error>
</response>
```

### 3.3 错误处理

#### 3.3.1 常见错误类型

1. **连接错误**: 无法连接到服务器
2. **超时错误**: 等待响应超时
3. **协议错误**: 无效的头部或长度
4. **命令错误**: 不支持的命令或参数错误
5. **状态错误**: 服务器状态不允许执行该命令

#### 3.3.2 错误处理建议

- 对网络错误实施重试机制（最多 3 次）
- 解析 `<e>` 标签获取详细错误信息
- 记录所有错误以便调试
- 对关键操作实施确认机制

---

## 4. 命令参考

### 4.1 基础命令

#### 4.1.1 HEARTBEAT - 心跳检测

**描述**: 用于测试服务器连接是否正常

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="HEARTBEAT"/>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2"/>
```

**用途**:
- 测试连接状态
- 保持连接活跃
- 健康检查

---

#### 4.1.2 SET_ENCODING - 设置编码

**描述**: 设置后续响应使用的字符编码

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="SET_ENCODING">
  <encoding type="UTF-8"/>
</command>
```

**参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| encoding type | String | 是 | 编码类型，目前支持 "UTF-8" |

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2"/>
```

**注意事项**:
- 默认编码为 ASCII
- 设置仅对当前连接有效
- 断开连接后会重置为默认值

---

#### 4.1.3 GET_SUPPORTED_COMMANDS - 获取支持的命令列表

**描述**: 获取服务器支持的所有 API 命令

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_SUPPORTED_COMMANDS"/>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2">
  <command>HEARTBEAT</command>
  <command>GET_CPL_LIST</command>
  <command>PLAY_SHOW</command>
  <!-- 更多命令 -->
</response>
```

**用途**:
- 检查服务器支持的功能


---

### 4.2 CPL管理

#### 4.2.1 GET_CPL_LIST - 获取CPL列表

**描述**: 获取服务器上存在的 CPL (Composition Playlist) 列表

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_CPL_LIST" list_all="false" storage="all"/>
```

**参数**:

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| list_all | Boolean | 否 | false | true: 返回所有CPL（包括不完整的）<br>false: 仅返回完整CPL |
| storage | String | 否 | all | "all": 所有存储<br>"primary": 仅主存储 |

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2">
 <cpl_uuid ingest_datetime="2025-09-24T17:40:26+08:00" >urn:uuid:229f189c-6111-4f53-83dc-0711f0a8eabb</cpl_uuid>
 <cpl_uuid ingest_datetime="2025-09-29T12:53:20+08:00" >urn:uuid:4049d176-0b66-478d-a6a2-2d9500b78402</cpl_uuid>
</response>
```

**返回元素**:
- `cpl_uuid`: CPL 的唯一标识符
  - `ingest_datetime` 属性: CPL 导入时间（ISO 8601 格式）

---

#### 4.2.2 GET_CPL - 获取CPL内容

**描述**: 获取指定 CPL 的完整 XML 内容

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_CPL">
  <cpl_uuid>urn:uuid:229f189c-6111-4f53-83dc-0711f0a8eabb</cpl_uuid>
</command>
```

**参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| cpl_uuid | UUID | 是 | CPL 的唯一标识符 |

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2" >
 <response_text>&lt;?xml version=&quot;1.0&quot; encoding=&quot;UTF-8&quot; standalone=&quot;no&quot; ?&gt;&lt;PackingList xmlns=&quot;http://www.digicine.com/PROTO-ASDCP-PKL-20040311#&quot;&gt;
&lt;Id&gt;urn:uuid:f9bd5e56-e18e-451d-a544-af6d44d7e407&lt;/Id&gt;
&lt;AnnotationText&gt;XiaYiGeTaiFeng-2D_185_JP_96M_51_PTH_1010&lt;/AnnotationText&gt;
&lt;IssueDate&gt;2025-10-10T07:47:37-00:00&lt;/IssueDate&gt;
&lt;Issuer&gt;XiaYiGeTaiFeng-2D_185_JP_96M_51_PTH_1010&lt;/Issuer&gt;
&lt;Creator&gt;ClipsterDCI 6.9.3.2&lt;/Creator&gt;
&lt;AssetList&gt;
&lt;Asset&gt;
&lt;Id&gt;urn:uuid:0b9a52e2-1130-4409-b0f3-0e4d12ca3c16&lt;/Id&gt;
&lt;Hash&gt;6ioS6voU+f05fB+KtWMv5IERlWM=&lt;/Hash&gt;
&lt;Size&gt;111669014&lt;/Size&gt;
&lt;Type&gt;application/x-smpte-mxf;asdcpKind=Sound&lt;/Type&gt;
&lt;OriginalFileName&gt;XiaYiGeTaiFeng-2D_185_JP_96M_51_PTH_1010_audio_01.mxf&lt;/OriginalFileName&gt;
&lt;/Asset&gt;
&lt;Asset&gt;
&lt;Id&gt;urn:uuid:12c23965-44ef-4368-a530-13953c406841&lt;/Id&gt;
&lt;Hash&gt;BJItv/OW4Qnq3Z7Yo7NYIpvrA2g=&lt;/Hash&gt;
&lt;Size&gt;24358627065&lt;/Size&gt;
&lt;Type&gt;application/x-smpte-mxf;asdcpKind=Picture&lt;/Type&gt;
&lt;OriginalFileName&gt;XiaYiGeTaiFeng-2D_185_JP_96M_51_PTH_1010_05.mxf&lt;/OriginalFileName&gt;
&lt;/Asset&gt;
&lt;Asset&gt;
&lt;Id&gt;urn:uuid:15a29a39-18b4-4ac9-8332-dd63f3eefd37&lt;/Id&gt;
&lt;Hash&gt;poiQm1sbwjRzwmdlspTV8YhWHXc=&lt;/Hash&gt;
&lt;Size&gt;981507542&lt;/Size&gt;
&lt;Type&gt;application/x-smpte-mxf;asdcpKind=Sound&lt;/Type&gt;
&lt;OriginalFileName&gt;XiaYiGeTaiFeng-2D_185_JP_96M_51_PTH_1010_audio_05.mxf&lt;/OriginalFileName&gt;
&lt;/Asset&gt;
&lt;Asset&gt;
&lt;Id&gt;urn:uuid:32056fbc-382b-4bd7-94a0-fb72e6a7b6c9&lt;/Id&gt;
&lt;Hash&gt;BtXLBQ02apLgSmjPEDESH6jwAG0=&lt;/Hash&gt;
&lt;Size&gt;24383119399&lt;/Size&gt;
&lt;Type&gt;application/x-smpte-mxf;asdcpKind=Picture&lt;/Type&gt;
&lt;OriginalFileName&gt;XiaYiGeTaiFeng-2D_185_JP_96M_51_PTH_1010_03.mxf&lt;/OriginalFileName&gt;
&lt;/Asset&gt;
&lt;Asset&gt;
&lt;Id&gt;urn:uuid:3705498e-0155-4ed5-bf0e-dc506a76d225&lt;/Id&gt;
&lt;Hash&gt;F+Mf9sUArY4+X9O6i+dD+aC4J60=&lt;/Hash&gt;
&lt;Size&gt;1102026902&lt;/Size&gt;
&lt;Type&gt;application/x-smpte-mxf;asdcpKind=Sound&lt;/Type&gt;
&lt;OriginalFileName&gt;XiaYiGeTaiFeng-2D_185_JP_96M_51_PTH_1010_audio_02.mxf&lt;/OriginalFileName&gt;
&lt;/Asset&gt;
&lt;Asset&gt;
&lt;Id&gt;urn:uuid:4bed229b-e04d-47fc-9ed0-e6a4271c90d5&lt;/Id&gt;
&lt;Hash&gt;YVnmuh1uDWOxLEdUsLDj8Tn5m+Y=&lt;/Hash&gt;
&lt;Size&gt;973183382&lt;/Size&gt;
&lt;Type&gt;application/x-smpte-mxf;asdcpKind=Sound&lt;/Type&gt;
&lt;OriginalFileName&gt;XiaYiGeTaiFeng-2D_185_JP_96M_51_PTH_1010_audio_03.mxf&lt;/OriginalFileName&gt;
&lt;/Asset&gt;
&lt;Asset&gt;
&lt;Id&gt;urn:uuid:60ca4df4-db91-4900-8503-1e7ed051bf7e&lt;/Id&gt;
&lt;Hash&gt;uqgVj9O23ECj2QtynKVCGa4YrXY=&lt;/Hash&gt;
&lt;Size&gt;2279718663&lt;/Size&gt;
&lt;Type&gt;application/x-smpte-mxf;asdcpKind=Picture&lt;/Type&gt;
&lt;OriginalFileName&gt;XiaYiGeTaiFeng-2D_185_JP_96M_51_PTH_1010_01.mxf&lt;/OriginalFileName&gt;
&lt;/Asset&gt;
&lt;Asset&gt;
&lt;Id&gt;urn:uuid:6600085f-ebd9-4891-a5d5-1e6a24e3b55b&lt;/Id&gt;
&lt;Hash&gt;RRSZytef17KJBbp9ksc0D6z0iEM=&lt;/Hash&gt;
&lt;Size&gt;19615513133&lt;/Size&gt;
&lt;Type&gt;application/x-smpte-mxf;asdcpKind=Picture&lt;/Type&gt;
&lt;OriginalFileName&gt;XiaYiGeTaiFeng-2D_185_JP_96M_51_PTH_1010_06.mxf&lt;/OriginalFileName&gt;
&lt;/Asset&gt;
&lt;Asset&gt;
&lt;Id&gt;urn:uuid:7fa71d30-230a-4eae-b674-b96f11c86e5f&lt;/Id&gt;
&lt;Hash&gt;9FSGm/8oFz/bzqheJjgTtDQ6OzI=&lt;/Hash&gt;
&lt;Size&gt;27714404491&lt;/Size&gt;
&lt;Type&gt;application/x-smpte-mxf;asdcpKind=Picture&lt;/Type&gt;
&lt;OriginalFileName&gt;XiaYiGeTaiFeng-2D_185_JP_96M_51_PTH_1010_02.mxf&lt;/OriginalFileName&gt;
&lt;/Asset&gt;
&lt;Asset&gt;
&lt;Id&gt;urn:uuid:8b73b8e6-4112-4d49-ae39-9d28f7410d9e&lt;/Id&gt;
&lt;Hash&gt;qV9ot6eDSXI8shK8wTyQ0X5Ea0I=&lt;/Hash&gt;
&lt;Size&gt;29931817763&lt;/Size&gt;
&lt;Type&gt;application/x-smpte-mxf;asdcpKind=Picture&lt;/Type&gt;
&lt;OriginalFileName&gt;XiaYiGeTaiFeng-2D_185_JP_96M_51_PTH_1010_04.mxf&lt;/OriginalFileName&gt;
&lt;/Asset&gt;
&lt;Asset&gt;
&lt;Id&gt;urn:uuid:a62dc216-3541-4180-9764-a3451dac1aa7&lt;/Id&gt;
&lt;AnnotationText&gt;XiaYiGeTaiFeng-2D_185_JP_96M_51_PTH_1010&lt;/AnnotationText&gt;
&lt;Hash&gt;SggAXEeJMuCwoTbk64Fdy8HwTUY=&lt;/Hash&gt;
&lt;Size&gt;13905&lt;/Size&gt;
&lt;Type&gt;text/xml;asdcpKind=CPL&lt;/Type&gt;
&lt;OriginalFileName&gt;CPL_XiaYiGeTaiFeng-2D_185_JP_96M_51_PTH_1010.xml&lt;/OriginalFileName&gt;
&lt;/Asset&gt;
&lt;Asset&gt;
&lt;Id&gt;urn:uuid:af30fbd9-5851-4970-8be3-bed86bad4543&lt;/Id&gt;
&lt;Hash&gt;O0/X0YeIRX2tfzWvFgpOlBaHt5o=&lt;/Hash&gt;
&lt;Size&gt;1131849110&lt;/Size&gt;
&lt;Type&gt;application/x-smpte-mxf;asdcpKind=Sound&lt;/Type&gt;
&lt;OriginalFileName&gt;XiaYiGeTaiFeng-2D_185_JP_96M_51_PTH_1010_audio_04.mxf&lt;/OriginalFileName&gt;
&lt;/Asset&gt;
&lt;Asset&gt;
&lt;Id&gt;urn:uuid:e77424ec-046a-45ae-8822-ca87b6d7bc57&lt;/Id&gt;
&lt;Hash&gt;um6sj/OTwYBqN5Uc4T0FjY4WbZ4=&lt;/Hash&gt;
&lt;Size&gt;818209238&lt;/Size&gt;
&lt;Type&gt;application/x-smpte-mxf;asdcpKind=Sound&lt;/Type&gt;
&lt;OriginalFileName&gt;XiaYiGeTaiFeng-2D_185_JP_96M_51_PTH_1010_audio_06.mxf&lt;/OriginalFileName&gt;
&lt;/Asset&gt;
&lt;/AssetList&gt;
&lt;Signer xmlns:ds=&quot;http://www.w3.org/2000/09/xmldsig#&quot;&gt;&lt;ds:X509Data xmlns:ds=&quot;http://www.w3.org/2000/09/xmldsig#&quot;&gt;
&lt;ds:X509IssuerSerial&gt;
&lt;ds:X509IssuerName&gt;dnQualifier=4py0tKtJ07bHLNbKepu4FAd82xw=,OU=.Clipster.FBMS.DC.CA.RuS,O=.DC.CA.RuS,CN=.Vimp1604&lt;/ds:X509IssuerName&gt;
&lt;ds:X509SerialNumber&gt;165150038&lt;/ds:X509SerialNumber&gt;
&lt;/ds:X509IssuerSerial&gt;
&lt;/ds:X509Data&gt;&lt;/Signer&gt;&lt;ds:Signature xmlns:ds=&quot;http://www.w3.org/2000/09/xmldsig#&quot;&gt;
&lt;ds:SignedInfo&gt;
&lt;ds:CanonicalizationMethod Algorithm=&quot;http://www.w3.org/TR/2001/REC-xml-c14n-20010315&quot;/&gt;
&lt;ds:SignatureMethod Algorithm=&quot;http://www.w3.org/2000/09/xmldsig#rsa-sha1&quot;/&gt;
&lt;ds:Reference URI=&quot;&quot;&gt;
&lt;ds:Transforms&gt;
&lt;ds:Transform Algorithm=&quot;http://www.w3.org/2000/09/xmldsig#enveloped-signature&quot;/&gt;
&lt;/ds:Transforms&gt;
&lt;ds:DigestMethod Algorithm=&quot;http://www.w3.org/2000/09/xmldsig#sha1&quot;/&gt;
&lt;ds:DigestValue&gt;vm9M9huVSQqMxFKuPLPqKP34eJo=&lt;/ds:DigestValue&gt;
&lt;/ds:Reference&gt;
&lt;/ds:SignedInfo&gt;
&lt;ds:SignatureValue&gt;i7kRVEWzp12CRpqwERJxkP4QsU+BB4Kr3INhog99oKTQuAFCXqnYb8J/17wmZdHh
4ysTI47fitKRhfs05PM/3WZ5OvBtnJ/EBC0GDvRY9MBwRBG+fTqCHyYPh8Ecex97
KVAeusdKiH+zXLD66nf0f0HGWVsIXlUgr0cW59Ve56dYd4NQliLyUMgGY03Ka+S4
pd1PxJZuiIBwFqqZvAGYfsFM9JcGXXxkyUbA6IAtmFSDhSnFLriMzuA2kJOHGjDu
GwnlNy4bX/qTxkhx+V4Y2BdqPMgDsuNhdysR5CXBpr9r++x0p8fPmKoxeMuy/Smi
+mFLX71vby7sn4Zq3olABQ==&lt;/ds:SignatureValue&gt;
&lt;ds:KeyInfo&gt;
&lt;ds:X509Data&gt;
&lt;ds:X509IssuerSerial&gt;
&lt;ds:X509IssuerName&gt;dnQualifier=4py0tKtJ07bHLNbKepu4FAd82xw=,OU=.Clipster.FBMS.DC.CA.RuS,O=.DC.CA.RuS,CN=.Vimp1604&lt;/ds:X509IssuerName&gt;
&lt;ds:X509SerialNumber&gt;165150038&lt;/ds:X509SerialNumber&gt;
&lt;/ds:X509IssuerSerial&gt;
&lt;ds:X509Certificate&gt;<!-- Certificate -->
&lt;/ds:X509Certificate&gt;
&lt;/ds:X509Data&gt;
&lt;ds:X509Data&gt;
&lt;ds:X509IssuerSerial&gt;
&lt;ds:X509IssuerName&gt;dnQualifier=wiwAlHjwPoipV5wvDwZY0XTaiMM=,OU=.FBMS.DC.CA.RuS,O=.DC.CA.RuS,CN=.Clipster&lt;/ds:X509IssuerName&gt;
&lt;ds:X509SerialNumber&gt;9714&lt;/ds:X509SerialNumber&gt;
&lt;/ds:X509IssuerSerial&gt;
&lt;ds:X509Certificate&gt;<!-- Certificate -->
&lt;/ds:X509Certificate&gt;
&lt;/ds:X509Data&gt;
&lt;ds:X509Data&gt;
&lt;ds:X509IssuerSerial&gt;
&lt;ds:X509IssuerName&gt;dnQualifier=JknMF1MuF3k1Jg/bEfmnZ5i6yfs=,OU=.DC.CA.RuS,O=.DC.CA.RuS,CN=.FBMS&lt;/ds:X509IssuerName&gt;
&lt;ds:X509SerialNumber&gt;9712&lt;/ds:X509SerialNumber&gt;
&lt;/ds:X509IssuerSerial&gt;
&lt;ds:X509Certificate&gt;<!-- Certificate -->
&lt;/ds:X509Certificate&gt;
&lt;/ds:X509Data&gt;
&lt;ds:X509Data&gt;
&lt;ds:X509IssuerSerial&gt;
&lt;ds:X509IssuerName&gt;dnQualifier=JknMF1MuF3k1Jg/bEfmnZ5i6yfs=,OU=.DC.CA.RuS,O=.DC.CA.RuS,CN=.FBMS&lt;/ds:X509IssuerName&gt;
&lt;ds:X509SerialNumber&gt;9711&lt;/ds:X509SerialNumber&gt;
&lt;/ds:X509IssuerSerial&gt;
&lt;ds:X509Certificate&gt;<!-- Certificate -->
&lt;/ds:X509Certificate&gt;
&lt;/ds:X509Data&gt;
&lt;/ds:KeyInfo&gt;
&lt;/ds:Signature&gt;
&lt;/PackingList&gt;</response_text>
</response>


```

---

#### 4.2.3 VALIDATE_CPL - 验证CPL

**描述**: 验证 CPL 的完整性，检查所有必需资产是否可用

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="VALIDATE_CPL">
  <cpl_uuid>urn:uuid:12345678-1234-1234-1234-123456789012</cpl_uuid>
</command>
```

**参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| cpl_uuid | UUID | 是 | 要验证的 CPL UUID |

**验证成功**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2">
</response>
```
**验证失败**:
```xml
<?xml version = '1.0' encoding = 'UTF-8'?>
<response status="ERROR" version="2.2" >
 <error>Error validating CPL for playback</error>
 <cpl_uuid>urn:uuid:05abee6a-b5c1-430f-a157-7b4ea4eccd60</cpl_uuid>
 <error_list>
  <error code="0x001" asset_uuid="urn:uuid:05abee6a-b5c1-430f-a157-7b4ea4eccd60" asset_type="CPL" description="File missing" />
 </error_list>
</response>
```

**返回元素**:
- `error`: 错误信息
- `cpl_uuid`: cpl_uuid
- `error_list`: 错误列表

---

#### 4.2.4 GET_PACKAGE_LIST - 获取包列表

**描述**: 获取服务器上的 DCP 包列表

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_PACKAGE_LIST"/>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2" >
 <package annotation="XiaYiGeTaiFeng-2D_185_JP_96M_51_PTH_1010" issue_date="2025-10-10T07:47:37-00:00" >urn:uuid:f9bd5e56-e18e-451d-a544-af6d44d7e407</package>
 <package annotation="CiShaXiaoShuoJia2-2D_235_JP_134M_51_PTH_0923" issue_date="2025-09-23T10:30:46-00:00" >urn:uuid:f0966717-db83-4d14-a4b4-8ef05d487bb6</package>
</response>
```

---

### 4.3 KDM管理

#### 4.3.1 GET_KDM_LIST - 获取KDM列表

**描述**: 获取服务器上存在的 KDM (Key Delivery Message) 列表

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_KDM_LIST"/>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2" >
 <asset_uuid>urn:uuid:caf77faa-bee7-42e3-9643-04f99e48c8b5</asset_uuid>
 <asset_uuid>urn:uuid:0153c9c9-aff3-49e8-8e7e-257a125e9119</asset_uuid>
</response>

```

---

#### 4.3.2 GET_KDM - 获取KDM内容

**描述**: 获取指定 KDM 的完整 XML 内容

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_KDM">
  <asset_uuid>urn:uuid:caf77faa-bee7-42e3-9643-04f99e48c8b5</asset_uuid>
</command>
```

**参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| asset_uuid | UUID | 是 | KDM 的唯一标识符 |

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2">
  <response_text>
    &lt;?xml version=&quot;1.0&quot; encoding=&quot;UTF-8&quot;?&gt;
    &lt;DCinemaSecurityMessage xmlns=&quot;http://www.smpte-ra.org/schemas/430-3/2006/ETM&quot;&gt;
      &lt;AuthenticatedPublic&gt;
        &lt;MessageId&gt;urn:uuid:caf77faa-bee7-42e3-9643-04f99e48c8b5&lt;/MessageId&gt;
        &lt;MessageType&gt;KDM&lt;/MessageType&gt;
        &lt;AnnotationText&gt;KDM_ZhuZhuXiaYiZhiLaoZhuDeNiXi_FTR-2D-24&lt;/AnnotationText&gt;
        &lt;IssueDate&gt;2025-10-30T16:00:40+08:00&lt;/IssueDate&gt;

        &lt;Recipient&gt;
          &lt;X509IssuerName&gt;CN=.SA2100.SERVERS.PRODUCTS.CA.GDC-TECH.COM&lt;/X509IssuerName&gt;
          &lt;X509SerialNumber&gt;308716&lt;/X509SerialNumber&gt;
        &lt;/Recipient&gt;

        &lt;CompositionPlaylistId&gt;urn:uuid:4049d176-0b66-478d-a6a2-2d9500b78402&lt;/CompositionPlaylistId&gt;
        &lt;ContentTitleText&gt;ZhuZhuXiaYiZhiLaoZhuDeNiXi_FTR-2D-24_S_CMN-QMS&lt;/ContentTitleText&gt;
        &lt;ContentKeysNotValidBefore&gt;2025-11-01T00:00:00+08:00&lt;/ContentKeysNotValidBefore&gt;
        &lt;ContentKeysNotValidAfter&gt;2025-11-30T23:59:59+08:00&lt;/ContentKeysNotValidAfter&gt;

        &lt;AuthorizedDeviceInfo&gt;
          &lt;DeviceListIdentifier&gt;urn:uuid:0c84f2b8-4abc-475f-b5b2-14a018705d4a&lt;/DeviceListIdentifier&gt;
        &lt;/AuthorizedDeviceInfo&gt;

        &lt;KeyIdList&gt;
          &lt;TypedKeyId&gt;
            &lt;KeyType&gt;MDIK&lt;/KeyType&gt;
            &lt;KeyId&gt;urn:uuid:f953346b-e923-4fa9-aaed-c9670bd48600&lt;/KeyId&gt;
          &lt;/TypedKeyId&gt;
          ...（略）...
        &lt;/KeyIdList&gt;
      &lt;/AuthenticatedPublic&gt;

      &lt;AuthenticatedPrivate&gt;
        &lt;EncryptedKey&gt;...（加密内容省略）...&lt;/EncryptedKey&gt;
      &lt;/AuthenticatedPrivate&gt;

      &lt;Signature&gt;...（签名与证书内容省略）...&lt;/Signature&gt;
    &lt;/DCinemaSecurityMessage&gt;
  </response_text>
</response>

```

---

### 4.4 放映列表管理(SHOW)

> **注意**: 在实际实现中，放映列表使用 **SHOW** 而不是文档中的 SPL

#### 4.4.1 PUT_SHOW - 创建/更新放映列表

**描述**: 创建新的放映列表或更新现有放映列表

> **重要修正（已实机验证）**:
> `PUT_SHOW` **不接受** `<show_name>`、`<cpl_uuid>` 这样的简化参数。
> 实际可用格式必须通过 `<command_text>` 传入一整段转义后的 `ShowPlaylist` XML。
> 使用错误格式时，设备会返回：
> `<error>No command_text element found in the command XML</error>`

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="PUT_SHOW">
  <command_text>
    &lt;?xml version="1.0" encoding="UTF-8" standalone="no" ?&gt;
    &lt;ShowPlaylist xmlns="http://www.smpte-ra.org/430-8/2006/SPL"&gt;
      &lt;Id&gt;urn:uuid:366d18f2-d488-4322-8d0e-85cc23b5124c&lt;/Id&gt;
      &lt;IssueDate&gt;2026-04-22T22:17:10+08:00&lt;/IssueDate&gt;
      &lt;Issuer&gt;GDC&lt;/Issuer&gt;
      &lt;Creator&gt;SMS&lt;/Creator&gt;
      &lt;ShowTitleText&gt;TEST&lt;/ShowTitleText&gt;
      &lt;ContentVersion&gt;
        &lt;Id&gt;fd900661-c4a4-4a05-955b-e37126c1c1c3&lt;/Id&gt;
        &lt;LabelText&gt;GDC SPL&lt;/LabelText&gt;
      &lt;/ContentVersion&gt;
      &lt;PackList&gt;
        &lt;PlaylistPack&gt;
          &lt;Id&gt;urn:uuid:dd21b54f-9130-4260-9412-f74b91dd4c0d&lt;/Id&gt;
          &lt;PlayTypeChoice&gt;
            &lt;PlayCount&gt;1&lt;/PlayCount&gt;
          &lt;/PlayTypeChoice&gt;
          &lt;Playlist&gt;
            &lt;CompositionPlaylistId&gt;urn:uuid:229f189c-6111-4f53-83dc-0711f0a8eabb&lt;/CompositionPlaylistId&gt;
            &lt;CompositionPlaylistId&gt;urn:uuid:a941e21c-46e6-420e-ac1c-04e67a6dc914&lt;/CompositionPlaylistId&gt;
            &lt;CompositionPlaylistId&gt;urn:uuid:01633800-23c0-4a08-8c69-d7f4b99cd8e4&lt;/CompositionPlaylistId&gt;
          &lt;/Playlist&gt;
        &lt;/PlaylistPack&gt;
      &lt;/PackList&gt;
    &lt;/ShowPlaylist&gt;
  </command_text>
</command>
```

**参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| command_text | String | 是 | 转义后的完整 `ShowPlaylist` XML |

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2" />
```

**说明**:
- 成功响应仅返回 `OK`，**不会**返回 `<show_uuid>`
- `show_uuid` 需要从提交的 `ShowPlaylist/Id` 中自行生成并维护
- 如果只需要“一个或多个 CPL”的简单播放列表，可以构造最小 `ShowPlaylist`：
  仅包含 `Id`、`IssueDate`、`Issuer`、`Creator`、`ShowTitleText`、`ContentVersion`、`PackList/PlaylistPack/Playlist/CompositionPlaylistId`

---

#### 4.4.2 GET_SHOW_LIST - 获取放映列表

**描述**: 获取服务器上所有放映列表

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_SHOW_LIST"/>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2" >
 <show_uuid>urn:uuid:5636e7f5-bb5a-49b0-bd0f-91d2e092f58c</show_uuid>
 <show_uuid>urn:uuid:92b2fa59-c420-4fa4-bb14-c9f4be5e9763</show_uuid>
</response>

```

---

#### 4.4.3 GET_SHOW - 获取放映列表详情

**描述**: 获取指定放映列表的详细信息

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_SHOW">
  <show_uuid>urn:uuid:5636e7f5-bb5a-49b0-bd0f-91d2e092f58c</show_uuid>
</command>
```

**参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| show_uuid | UUID | 是 | 放映列表 UUID |

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2" >
 <response_text>&lt;?xml version=&quot;1.0&quot; encoding=&quot;UTF-8&quot; standalone=&quot;no&quot; ?&gt;
&lt;ShowPlaylist xmlns=&quot;http://www.smpte-ra.org/430-8/2006/SPL&quot;&gt;
  &lt;Id&gt;urn:uuid:5636e7f5-bb5a-49b0-bd0f-91d2e092f58c&lt;/Id&gt;
  &lt;IssueDate&gt;2025-10-02T16:33:23+08:00&lt;/IssueDate&gt;
  &lt;Issuer&gt;GDC&lt;/Issuer&gt;
  &lt;Creator&gt;SMS&lt;/Creator&gt;
  &lt;ShowTitleText&gt;Z E Y L      3f10&lt;/ShowTitleText&gt;
  &lt;ContentVersion&gt;
    &lt;Id&gt;04140241-dfc8-4e22-bad8-21b97661ed90&lt;/Id&gt;
    &lt;LabelText&gt;GDC SPL&lt;/LabelText&gt;
  &lt;/ContentVersion&gt;
  &lt;PackList&gt;
    &lt;PlaylistPack&gt;
      &lt;Id&gt;urn:uuid:e3e1595c-4187-4747-9588-372116018e2c&lt;/Id&gt;
      &lt;PlayTypeChoice&gt;
        &lt;PlayCount&gt;1&lt;/PlayCount&gt;
      &lt;/PlayTypeChoice&gt;
      &lt;Playlist&gt;
        &lt;PlaylistMarker&gt;
          &lt;Id&gt;urn:uuid:eae105df-c3d8-496c-9278-2e7737aca0c8&lt;/Id&gt;
          &lt;Label&gt;XianDeng&amp;amp;GuangZha_on&lt;/Label&gt;
          &lt;AnnotationText&gt;XianDeng&amp;amp;GuangZha_on&lt;/AnnotationText&gt;
        &lt;/PlaylistMarker&gt;
        &lt;CompositionPlaylistId&gt;urn:uuid:229f189c-6111-4f53-83dc-0711f0a8eabb&lt;/CompositionPlaylistId&gt;
        &lt;PlaylistMarker&gt;
          &lt;Id&gt;urn:uuid:cb0473f9-af7c-42a2-83d1-4b7ec0c080df&lt;/Id&gt;
          &lt;Label&gt;TongDao_5&lt;/Label&gt;
          &lt;AnnotationText&gt;TongDao_5&lt;/AnnotationText&gt;
        &lt;/PlaylistMarker&gt;
        &lt;PlaylistMarker&gt;
          &lt;Id&gt;urn:uuid:4ee305b6-d472-4ffd-96f6-d202c76ef729&lt;/Id&gt;
          &lt;Label&gt;XianDeng&amp;amp;GuangZha_off&lt;/Label&gt;
          &lt;AnnotationText&gt;XianDeng&amp;amp;GuangZha_off&lt;/AnnotationText&gt;
          &lt;Offset EditRate=&quot;24 1&quot;&gt;183214&lt;/Offset&gt;
        &lt;/PlaylistMarker&gt;
        &lt;CompositionPlaylistId&gt;urn:uuid:cc3758f4-9bdb-4d2f-a4d1-4ba91927cc61&lt;/CompositionPlaylistId&gt;
      &lt;/Playlist&gt;
    &lt;/PlaylistPack&gt;
  &lt;/PackList&gt;
&lt;/ShowPlaylist&gt;
</response_text>
</response>
```

---

#### 4.4.4 VALIDATE_SHOW - 验证放映列表

**描述**: 验证放映列表的完整性，包括所有 CPL 和必需的 KDM

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="VALIDATE_SHOW">
  <show_uuid>urn:uuid:show-aaaa-bbbb-cccc-dddddddddddd</show_uuid>
</command>
```

**参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| show_uuid | UUID | 是 | 放映列表 UUID |

**验证成功**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2" />

```
**验证失败**:
```xml
<?xml version = '1.0' encoding = 'UTF-8'?>
<response status="ERROR" version="2.2" >
 <error>Error validating show for playback</error>
 <show_uuid>urn:uuid:34b9f125-09c5-4e90-b68c-8859dccebd59</show_uuid>
 <error_list>
  <error code="0x003" asset_uuid="urn:uuid:abd57ada-8e69-4509-bd79-d65ad845d845" asset_type="CPL" description="No valid KDM" />
 </error_list>
</response>
```
---

#### 4.4.5 DELETE_SHOW - 删除放映列表

**描述**: 从服务器删除放映列表

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="DELETE_SHOW">
  <show_uuid>urn:uuid:show-aaaa-bbbb-cccc-dddddddddddd</show_uuid>
</command>
```

**参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| show_uuid | UUID | 是 | 要删除的放映列表 UUID |

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2"/>
```

**注意**: 删除放映列表不会删除其中包含的 CPL 内容

---

### 4.5 排期管理

#### 4.5.1 PUT_SCHEDULE - 创建/更新排期

**描述**: 为放映列表创建排期

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="PUT_SCHEDULE">
  <show_uuid>urn:uuid:show-aaaa-bbbb-cccc-dddddddddddd</show_uuid>
  <start_time>2025-11-06T19:30:00+08:00</start_time>
  <recurrence>once</recurrence>
</command>
```

**参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| show_uuid | UUID | 是 | 放映列表 UUID |
| start_time | DateTime | 是 | 开始时间（ISO 8601 格式）|
| recurrence | String | 否 | 重复模式: "once", "daily", "weekly" |

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2">
  <schedule_uuid>urn:uuid:sched-1111-2222-3333-444444444444</schedule_uuid>
</response>
```

---

#### 4.5.2 GET_SCHEDULES - 获取排期列表

**描述**: 获取所有排期

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_SCHEDULES"/>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2" >
 <schedule show_content_version_id="urn:uuid:b37c92bc-fa9f-4560-89b4-2b07ffa18879" playlist_duration="8272" show_content_ver_id="urn:uuid:b37c92bc-fa9f-4560-89b4-2b07ffa18879" iso_date_time="2025-10-06T15:15:20" >urn:uuid:31c555f2-84c1-4430-a538-c0a4bf5a2f17</schedule>
 <schedule show_content_version_id="urn:uuid:b37c92bc-fa9f-4560-89b4-2b07ffa18879" playlist_duration="8272" show_content_ver_id="urn:uuid:b37c92bc-fa9f-4560-89b4-2b07ffa18879" iso_date_time="2025-10-06T19:20:20" >urn:uuid:7707f898-dc8f-4f14-b327-3d5daf4816a9</schedule>
</response>
```

---

#### 4.5.3 GET_SCHEDULE - 获取排期详情

**描述**: 获取指定排期的详细信息

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_SCHEDULE">
  <schedule_uuid>urn:uuid:sched-1111-2222-3333-444444444444</schedule_uuid>
</command>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2">
  <schedule show_content_version_id="urn:uuid:b37c92bc-fa9f-4560-89b4-2b07ffa18879" 
            playlist_duration="8272" 
            show_content_ver_id="urn:uuid:b37c92bc-fa9f-4560-89b4-2b07ffa18879" 
            iso_date_time="2025-10-06T15:15:20">
    urn:uuid:31c555f2-84c1-4430-a538-c0a4bf5a2f17
  </schedule>
</response>
```
**返回元素**:
- `schedule`: 排期UUID
  - `show_content_version_id`: 放映列表内容版本ID
  - `playlist_duration`: 播放列表时长(秒)
  - `iso_date_time`: 排期开始时间


---

#### 4.5.4 GET_CURRENT_SCHEDULE - 获取当前排期

**描述**: 获取当前正在执行的排期

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_CURRENT_SCHEDULE"/>
```

**响应**: 
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2">
  <schedule show_content_version_id="urn:uuid:b37c92bc-fa9f-4560-89b4-2b07ffa18879" 
            playlist_duration="8272" 
            show_content_ver_id="urn:uuid:b37c92bc-fa9f-4560-89b4-2b07ffa18879" 
            iso_date_time="2025-10-06T15:15:20">
    urn:uuid:31c555f2-84c1-4430-a538-c0a4bf5a2f17
  </schedule>
</response>
```

**注意**: 如果当前没有执行的排期，将返回`<error>No schedule playing at the moment</error>`

---

#### 4.5.5 GET_NEXT_SCHEDULE - 获取下一个排期

**描述**: 获取下一个将要执行的排期

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_NEXT_SCHEDULE"/>
```

**响应**: 
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2">
  <schedule show_content_version_id="urn:uuid:b37c92bc-fa9f-4560-89b4-2b07ffa18879" 
            playlist_duration="8272" 
            show_content_ver_id="urn:uuid:b37c92bc-fa9f-4560-89b4-2b07ffa18879" 
            iso_date_time="2025-10-06T19:20:20">
    urn:uuid:7707f898-dc8f-4f14-b327-3d5daf4816a9
  </schedule>
</response>
```

**注意**: 如果没有下一个排期，会返回最近的排期

---

#### 4.5.6 CANCEL_SCHEDULE - 取消排期

**描述**: 取消指定的排期

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="CANCEL_SCHEDULE">
  <schedule_uuid>urn:uuid:sched-1111-2222-3333-444444444444</schedule_uuid>
</command>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2"/>
```

---

#### 4.5.7 ENABLE_SCHEDULER - 启用排期器

**描述**: 启用自动排期功能

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="ENABLE_SCHEDULER"/>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2"/>
```

---

#### 4.5.8 DISABLE_SCHEDULER - 禁用排期器

**描述**: 禁用自动排期功能

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="DISABLE_SCHEDULER"/>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2"/>
```

---

#### 4.5.9 GET_SCHEDULER_STATUS - 获取排期器状态

**描述**: 获取排期器的当前状态

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_SCHEDULER_STATUS"/>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2">
  <scheduler_status>enabled</scheduler_status>
</response>
```

**状态值**:
- `enabled`: 排期器已启用
- `disabled`: 排期器已禁用

---

### 4.6 播放控制

#### 4.6.1 GET_PLAYBACK_STATUS - 获取播放状态

**描述**: 获取当前播放状态和位置信息

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_PLAYBACK_STATUS"/>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2" >
 <status seqStateForSyncMode="SEQ_NOT_READY" state="PLAYING" >
  <show_uuid>urn:uuid:00e778b0-d3b4-4471-8e41-258bc64f431a</show_uuid>
  <show_name>7 3 1       30m</show_name>
  <show_position total_duration="7588" played_duration="747" />
  <cpl_uuid>urn:uuid:afcfa9bc-5186-4e20-b7a7-83ba2c956e85</cpl_uuid>
  <cpl_name>731_FTR_S_CMN-QMS-EN_126M_51_2K_20250910_HXFILM_OV</cpl_name>
  <cpl_position total_duration="7558" cpl_index="1" played_duration="717" storage="primary" />
 </status>
</response>

```


**返回元素说明**:

**status 属性**:
- `state`: 播放状态
  - `IDLE`: 空闲
  - `LOADING`: 加载中
  - `PLAYING`: 播放中
  - `PAUSED`: 已暂停
  - `STOPPED`: 已停止
- `seqStateForSyncMode`: 多机同步序列状态
  - `SEQ_NOT_READY`: 序列未就绪
  - `SEQ_READY`: 序列就绪
  - `SEQ_RUNNING`: 序列运行中

**status 子元素**:
- `show_uuid`: 当前放映列表的UUID
- `show_name`: 当前放映列表的名称
- `show_position`: 放映列表播放位置
  - `total_duration`: 放映列表总时长(秒)
  - `played_duration`: 已播放时长(秒,基于放映列表)
- `cpl_uuid`: 当前CPL的UUID
- `cpl_name`: 当前CPL的名称
- `cpl_position`: CPL播放位置
  - `total_duration`: CPL总时长(秒)
  - `cpl_index`: 当前CPL在放映列表中的索引(从1开始)
  - `played_duration`: 已播放时长(秒,基于CPL)
  - `storage`: CPL的存储位置("primary"或"secondary")

---

#### 4.6.2 LOAD_SHOW - 加载放映列表

**描述**: 将放映列表加载到播放器

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="LOAD_SHOW">
  <show_uuid>urn:uuid:show-aaaa-bbbb-cccc-dddddddddddd</show_uuid>
</command>
```

**参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| show_uuid | UUID | 是 | 要加载的放映列表 UUID |

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2"/>
```

**注意**: 加载后不会自动播放，需要调用 PLAY_SHOW

---

#### 4.6.3 CLEAR_SHOW - 清除放映列表

**描述**: 从播放器清除当前加载的放映列表

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="CLEAR_SHOW"/>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2"/>
```

---

#### 4.6.4 PLAY_SHOW - 播放

**描述**: 开始播放当前加载的放映列表

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="PLAY_SHOW"/>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2"/>
```

**前置条件**: 必须先调用 LOAD_SHOW 加载放映列表

---

#### 4.6.5 PAUSE_PLAYBACK - 暂停播放

**描述**: 暂停当前播放

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="PAUSE_PLAYBACK"/>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2"/>
```

---

#### 4.6.6 UNPAUSE_PLAYBACK - 恢复播放

**描述**: 恢复暂停的播放

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="UNPAUSE_PLAYBACK"/>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2"/>
```

---

#### 4.6.7 STOP_PLAYBACK - 停止播放

**描述**: 停止当前播放

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="STOP_PLAYBACK"/>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2"/>
```

---

#### 4.6.8 MOVE_PLAYBACK - 移动播放位置

**描述**: 将播放位置移动到指定时间码

**命令格式（指定时间）**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="MOVE_PLAYBACK">
  <absolute>01:00:00:10</absolute>
</command>
```
**命令格式（相对时间）**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="MOVE_PLAYBACK">
  <offset>300</offset>
</command>
```
**参数**:

| 参数 | 类型     | 必填                   | 说明                  |
|------|--------|----------------------|---------------------|
| absolute | String | (absolute\offset二选一) | 绝对时间码（HH:MM:SS:FPS） |
| offset | Int    | (absolute\offset二选一) | 基于当前播放位置，秒          |

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2"/>
```

---

#### 4.6.9 SKIP_FORWARD - 跳到下一个CPL

**描述**: 跳转到放映列表中的下一个 CPL

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="SKIP_FORWARD"/>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2"/>
```

---

#### 4.6.10 SKIP_BACKWARD - 跳到上一个CPL

**描述**: 跳转到放映列表中的上一个 CPL

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="SKIP_BACKWARD"/>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2"/>
```

---

### 4.7 内容摄取

> **注意**: 内容导入在实际实现中称为"摄取"(INGEST)

#### 4.7.1 INGEST_CONTENT - 摄取内容

**描述**: 从外部源摄取 DCP 内容到服务器

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="INGEST_CONTENT">
  <source>smb://192.168.1.100/movies/film1</source>
  <username>admin</username>
  <password>password123</password>
  <storage>primary</storage>
</command>
```

**参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| source | String | 是 | 内容源路径（支持 SMB、NFS 等）|
| username | String | 否 | 访问源的用户名 |
| password | String | 否 | 访问源的密码 |
| storage | String | 否 | 目标存储: "primary", "secondary" |

**支持的协议**:
- `smb://` - Windows 共享
- `nfs://` - NFS 共享
- `ftp://` - FTP 服务器
- `file://` - 本地路径

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2">
  <ingest_uuid>urn:uuid:ingest-aaaa-bbbb-cccc-dddddddddddd</ingest_uuid>
</response>
```

---

#### 4.7.2 UFO_INGEST_CONTENT - UFO摄取内容

**描述**: 使用 UFO 协议摄取内容（针对 UFO 设备优化）

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="UFO_INGEST_CONTENT">
  <source>ufo://device-id/content-path</source>
  <username>admin</username>
  <password>password123</password>
</command>
```

**响应**: 
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2">
  <ingest_uuid>urn:uuid:ingest-aaaa-bbbb-cccc-dddddddddddd</ingest_uuid>
</response>
```

---

#### 4.7.3 INGEST_FILE - 摄取文件

**描述**: 摄取单个文件（如 KDM、证书）

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="INGEST_FILE">
  <source>smb://192.168.1.100/kdms/film1.kdm.xml</source>
  <file_type>kdm</file_type>
  <username>admin</username>
  <password>password123</password>
</command>
```

**参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| source | String | 是 | 文件源路径 |
| file_type | String | 是 | 文件类型: "kdm", "certificate" |
| username | String | 否 | 访问源的用户名 |
| password | String | 否 | 访问源的密码 |

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2">
  <ingest_uuid>urn:uuid:ingest-1111-2222-3333-444444444444</ingest_uuid>
</response>
```

---

#### 4.7.4 GET_INGEST_STATUS - 获取摄取状态

**描述**: 查询摄取任务的进度和状态

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_INGEST_STATUS">
  <ingest_uuid>urn:uuid:ingest-aaaa-bbbb-cccc-dddddddddddd</ingest_uuid>
</command>
```

**参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| ingest_uuid | UUID | 是 | 摄取任务 UUID |

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2">
  <ingest_status>in_progress</ingest_status>
  <progress>45</progress>
  <source>smb://192.168.1.100/movies/film1</source>
  <bytes_transferred>1500000000</bytes_transferred>
  <total_bytes>3000000000</total_bytes>
</response>
```

**状态值**:
- `queued`: 排队中
- `in_progress`: 进行中
- `completed`: 已完成
- `failed`: 失败
- `cancelled`: 已取消

---

#### 4.7.5 GET_INGEST_LIST - 获取摄取列表

**描述**: 获取所有摄取任务

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_INGEST_LIST"/>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2">
  <ingest>
    <ingest_uuid>urn:uuid:ingest-aaaa-bbbb-cccc-dddddddddddd</ingest_uuid>
    <ingest_status>completed</ingest_status>
    <source>smb://192.168.1.100/movies/film1</source>
  </ingest>
  <ingest>
    <ingest_uuid>urn:uuid:ingest-1111-2222-3333-444444444444</ingest_uuid>
    <ingest_status>in_progress</ingest_status>
    <source>smb://192.168.1.100/movies/film2</source>
  </ingest>
</response>
```

---

#### 4.7.6 CANCEL_INGEST - 取消摄取

**描述**: 取消正在进行的摄取任务

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="CANCEL_INGEST">
  <ingest_uuid>urn:uuid:ingest-aaaa-bbbb-cccc-dddddddddddd</ingest_uuid>
</command>
```

**参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| ingest_uuid | UUID | 是 | 要取消的摄取任务 UUID |

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2"/>
```

**注意**: 只能取消状态为 `queued` 或 `in_progress` 的任务

---

### 4.8 内容删除

#### 4.8.1 DELETE_CONTENT - 删除内容

**描述**: 从服务器删除 DCP 内容及其所有相关资产

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="DELETE_CONTENT">
  <cpl_uuid>urn:uuid:12345678-1234-1234-1234-123456789012</cpl_uuid>
</command>
```

**参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| cpl_uuid | UUID | 是 | 要删除的 CPL UUID |

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2"/>
```

**警告**: 此操作不可逆，将删除所有相关资产文件

---

#### 4.8.2 UFO_DELETE_CONTENT - UFO删除内容

**描述**: 使用 UFO 协议删除内容

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="UFO_DELETE_CONTENT">
  <cpl_uuid>urn:uuid:12345678-1234-1234-1234-123456789012</cpl_uuid>
</command>
```

**响应**: 同 DELETE_CONTENT

---

#### 4.8.3 DELETE_FILE - 删除文件

**描述**: 删除特定文件（如 KDM）

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="DELETE_FILE">
  <file_uuid>urn:uuid:kdm-1111-2222-3333-444444444444</file_uuid>
  <file_type>kdm</file_type>
</command>
```

**参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| file_uuid | UUID | 是 | 文件 UUID |
| file_type | String | 是 | 文件类型: "kdm", "certificate" |

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2"/>
```

---

### 4.9 服务器信息

#### 4.9.1 GET_DATE_TIME - 获取服务器日期时间

**描述**: 获取服务器的当前日期和时间

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_DATE_TIME"/>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2">
  <datetime>2025-11-06T14:30:45+08:00</datetime>
</response>
```

---

#### 4.9.2 GET_CERTIFICATES - 获取证书

**描述**: 获取服务器的数字证书

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_CERTIFICATES"/>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2">
  <certificate>
    -----BEGIN CERTIFICATE-----
    MIIDXTCCAkWgAwIBAgIJAKJ...
    -----END CERTIFICATE-----
  </certificate>
</response>
```

---

#### 4.9.3 GET_CERTIFICATE_CHAIN - 获取证书链

**描述**: 获取完整的证书链

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_CERTIFICATE_CHAIN"/>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2">
  <chain algorithm="SHA-256">
    -----BEGIN CERTIFICATE-----
    ...证书链...
    -----END CERTIFICATE-----
  </chain>
</response>
```

---

#### 4.9.4 GET_SERVER_INFO - 获取服务器信息

**描述**: 获取服务器的详细信息

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_SERVER_INFO"/>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2">
  <server_info>
    <model>DSR-2000</model>
    <serial_number>SN123456789</serial_number>
    <software_version>8.01.123</software_version>
    <api_version>2.2</api_version>
    <firmware_version>1.5.2</firmware_version>
  </server_info>
</response>
```

---

#### 4.9.5 GET_STORAGE_INFO - 获取存储信息

**描述**: 获取服务器存储设备的容量信息

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_STORAGE_INFO"/>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2">
  <storage>
    <storage_name>primary</storage_name>
    <total_capacity>2000000000000</total_capacity>
    <used_capacity>500000000000</used_capacity>
    <available_capacity>1500000000000</available_capacity>
  </storage>
  <storage>
    <storage_name>secondary</storage_name>
    <total_capacity>4000000000000</total_capacity>
    <used_capacity>1000000000000</used_capacity>
    <available_capacity>3000000000000</available_capacity>
  </storage>
</response>
```

**容量单位**: 字节 (Bytes)

---

#### 4.9.6 GET_TIMEZONE - 获取时区

**描述**: 获取服务器配置的时区

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_TIMEZONE"/>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2">
  <timezone>Asia/Shanghai</timezone>
  <utc_offset>+08:00</utc_offset>
</response>
```

---

#### 4.9.7 GET_SERVER_IP_LIST - 获取服务器IP列表

**描述**: 获取服务器所有网络接口的 IP 地址

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_SERVER_IP_LIST"/>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2">
  <network>
    <ipaddr>192.168.1.100</ipaddr>
    <ipaddr>10.0.0.50</ipaddr>
  </network>
</response>
```

---

#### 4.9.8 GET_PROJECTOR_STATUS - 获取放映机状态

**描述**: 获取连接的放映机状态

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_PROJECTOR_STATUS"/>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2">
  <projector_status>已连接</projector_status>
  <projector_status>proj:info:lamp_hours:1234</projector_status>
  <projector_status>proj:warning:0x0101</projector_status>
</response>
```

**状态说明**:
- 第一个元素: 连接状态（"已连接" 或 "未连接"）
- 后续元素: 格式为 `[id]:[type]:[info]`

---

#### 4.9.9 GET_MULTI_SYNC_MODE - 获取多机同步模式

**描述**: 获取服务器的多机同步配置

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_MULTI_SYNC_MODE"/>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2">
  <multisync_mode>master</multisync_mode>
</response>
```

**模式值**:
- `none`: 未配置同步
- `master`: 主服务器
- `slave`: 从服务器

---

#### 4.9.10 GET_WARRANTY_EXPIRY - 获取保修到期日期

**描述**: 查询服务器保修信息

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_WARRANTY_EXPIRY"/>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2">
  <warranty_expiry>2026-12-31</warranty_expiry>
</response>
```

**返回值**:
- ISO 8601 日期格式: `YYYY-MM-DD`
- `Unknown`: 未找到保修信息

---

#### 4.9.11 GET_HOTFIX_LIST - 获取热修复列表

**描述**: 获取已安装的热修复补丁列表

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_HOTFIX_LIST"/>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2">
  <hotfix>hotfix-2025-01-001</hotfix>
  <hotfix>hotfix-2025-02-015</hotfix>
  <hotfix>hotfix-2025-03-008</hotfix>
</response>
```

---

### 4.10 资产管理

#### 4.10.1 GET_ASSET_INFO - 获取资产信息

**描述**: 获取指定资产的详细信息

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_ASSET_INFO">
  <asset_uuid>urn:uuid:asset-1111-2222-3333-444444444444</asset_uuid>
</command>
```

**参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| asset_uuid | UUID | 是 | 资产 UUID |

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2">
  <asset>
    <asset_uuid>urn:uuid:asset-1111-2222-3333-444444444444</asset_uuid>
    <asset_type>video</asset_type>
    <file_size>50000000000</file_size>
    <duration>5400</duration>
    <frame_rate>24</frame_rate>
    <resolution>2048x1080</resolution>
  </asset>
</response>
```

---

#### 4.10.2 GET_ASSET_SIZE - 获取资产大小

**描述**: 获取资产文件大小

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_ASSET_SIZE">
  <asset_uuid>urn:uuid:asset-1111-2222-3333-444444444444</asset_uuid>
</command>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2">
  <asset_size>50000000000</asset_size>
</response>
```

**大小单位**: 字节 (Bytes)

---

#### 4.10.3 GET_ASSET_URI - 获取资产URI

**描述**: 获取资产的文件系统路径

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_ASSET_URI">
  <asset_uuid>urn:uuid:asset-1111-2222-3333-444444444444</asset_uuid>
</command>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2">
  <asset_uri>file:///storage/primary/assets/video_track.mxf</asset_uri>
</response>
```

---

#### 4.10.4 GET_LIST_OF_ASSET_STATUS - 获取资产状态列表

**描述**: 获取所有资产的状态

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_LIST_OF_ASSET_STATUS"/>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2">
  <asset_status>
    <asset_uuid>urn:uuid:asset-1111-2222-3333-444444444444</asset_uuid>
    <status>complete</status>
  </asset_status>
  <asset_status>
    <asset_uuid>urn:uuid:asset-5555-6666-7777-888888888888</asset_uuid>
    <status>incomplete</status>
  </asset_status>
</response>
```

**状态值**:
- `complete`: 完整
- `incomplete`: 不完整
- `error`: 错误

---

#### 4.10.5 GET_ASSET_FILE - 获取资产文件

**描述**: 下载资产文件（用于备份或传输）

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_ASSET_FILE">
  <asset_uuid>urn:uuid:asset-1111-2222-3333-444444444444</asset_uuid>
</command>
```

**注意**: 此命令的响应可能包含二进制数据，具体实现取决于服务器配置

---

### 4.11 日志管理

#### 4.11.1 GET_CONTENT_LOGS - 获取内容日志

**描述**: 获取内容操作日志（摄取、删除等）

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_CONTENT_LOGS">
  <start_time>2025-11-01T00:00:00+08:00</start_time>
  <end_time>2025-11-06T23:59:59+08:00</end_time>
</command>
```

**参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| start_time | DateTime | 否 | 开始时间（ISO 8601）|
| end_time | DateTime | 否 | 结束时间（ISO 8601）|

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2">
  <log_entry>
    <timestamp>2025-11-06T10:30:00+08:00</timestamp>
    <operation>ingest</operation>
    <cpl_uuid>urn:uuid:12345678-1234-1234-1234-123456789012</cpl_uuid>
    <status>completed</status>
  </log_entry>
</response>
```

---

#### 4.11.2 GET_EVENT_LOGS - 获取事件日志

**描述**: 获取系统事件日志

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_EVENT_LOGS">
  <start_time>2025-11-01T00:00:00+08:00</start_time>
  <end_time>2025-11-06T23:59:59+08:00</end_time>
  <log_level>all</log_level>
</command>
```

**参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| start_time | DateTime | 否 | 开始时间 |
| end_time | DateTime | 否 | 结束时间 |
| log_level | String | 否 | 日志级别: "all", "error", "warning", "info" |

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2">
  <log_entry>
    <timestamp>2025-11-06T10:15:30+08:00</timestamp>
    <level>info</level>
    <message>系统启动完成</message>
  </log_entry>
  <log_entry>
    <timestamp>2025-11-06T10:20:15+08:00</timestamp>
    <level>warning</level>
    <message>磁盘空间不足 20%</message>
  </log_entry>
</response>
```

---

#### 4.11.3 GET_EVENT_LOGS_SMPTE - 获取SMPTE事件日志

**描述**: 获取符合 SMPTE 标准的事件日志

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_EVENT_LOGS_SMPTE">
  <start_time>2025-11-01T00:00:00+08:00</start_time>
  <end_time>2025-11-06T23:59:59+08:00</end_time>
</command>
```

**响应**: 格式同 GET_EVENT_LOGS，但符合 SMPTE DCP 标准

---

#### 4.11.4 GET_PERFORMANCE_LOGS_SMPTE - 获取SMPTE性能日志

**描述**: 获取性能监控日志

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_PERFORMANCE_LOGS_SMPTE">
  <start_time>2025-11-01T00:00:00+08:00</start_time>
  <end_time>2025-11-06T23:59:59+08:00</end_time>
</command>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2">
  <performance_log>
    <timestamp>2025-11-06T10:00:00+08:00</timestamp>
    <cpu_usage>45</cpu_usage>
    <memory_usage>60</memory_usage>
    <disk_io>1500</disk_io>
    <network_io>500</network_io>
  </performance_log>
</response>
```

---

#### 4.11.5 CLEAR_HISTORY - 清除历史记录

**描述**: 清除系统历史记录和日志

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="CLEAR_HISTORY"/>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2"/>
```

**警告**: 此操作不可逆

---

### 4.12 直播源管理

#### 4.12.1 ADD_LIVEPLAY_SOURCE - 添加直播源

**描述**: 添加直播源配置

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="ADD_LIVEPLAY_SOURCE">
  <source_name>直播频道1</source_name>
  <source_url>rtmp://192.168.1.50/live/stream1</source_url>
  <source_type>rtmp</source_type>
</command>
```

**参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| source_name | String | 是 | 直播源名称 |
| source_url | String | 是 | 直播源 URL |
| source_type | String | 是 | 类型: "rtmp", "hls", "sdi" |

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2">
  <live_source_uuid>urn:uuid:live-aaaa-bbbb-cccc-dddddddddddd</live_source_uuid>
</response>
```

---

#### 4.12.2 LIST_LIVEPLAY_SOURCE - 列出直播源

**描述**: 获取所有配置的直播源

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="LIST_LIVEPLAY_SOURCE"/>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2">
  <live_source>
    <live_source_uuid>urn:uuid:live-aaaa-bbbb-cccc-dddddddddddd</live_source_uuid>
    <source_name>直播频道1</source_name>
    <source_type>rtmp</source_type>
    <source_url>rtmp://192.168.1.50/live/stream1</source_url>
  </live_source>
</response>
```

---

#### 4.12.3 REMOVE_LIVEPLAY_SOURCE - 移除直播源

**描述**: 删除直播源配置

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="REMOVE_LIVEPLAY_SOURCE">
  <live_source_uuid>urn:uuid:live-aaaa-bbbb-cccc-dddddddddddd</live_source_uuid>
</command>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2"/>
```

---

### 4.13 自动化控制

#### 4.13.1 TRIGGER_AUTOMATION - 触发自动化

**描述**: 手动触发自动化宏或标签

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="TRIGGER_AUTOMATION">
  <automation_id>macro001</automation_id>
</command>
```

**参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| automation_id | String | 是 | 自动化 ID |

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2"/>
```

---

#### 4.13.2 GET_AUTOMATION_LABELS - 获取自动化标签

**描述**: 获取系统配置的所有自动化标签

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_AUTOMATION_LABELS"/>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2">
  <automation_label>
    <label_id>macro001</label_id>
    <label_type>macro</label_type>
    <description>开场灯光控制</description>
  </automation_label>
  <automation_label>
    <label_id>cue002</label_id>
    <label_type>cue</label_type>
    <description>幕布控制</description>
  </automation_label>
</response>
```

---

### 4.14 系统文件

#### 4.14.1 GET_SYSTEM_FILE - 获取系统文件

**描述**: 获取系统配置文件或日志文件

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_SYSTEM_FILE">
  <file_path>/config/server.conf</file_path>
</command>
```

**参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| file_path | String | 是 | 文件路径 |

**注意**: 响应可能包含文件内容或下载链接

---

#### 4.14.2 PUT_SYSTEM_FILE - 上传系统文件

**描述**: 上传系统配置文件

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="PUT_SYSTEM_FILE">
  <file_path>/config/server.conf</file_path>
  <file_type>config</file_type>
</command>
```

**注意**: 文件内容应在命令后以适当方式传输（具体实现依赖服务器）

---

### 4.15 IMOP功能

> IMOP (Integrated Media Operations Platform) 是集成媒体操作平台

#### 4.15.1 ENABLE_IMOP - 启用IMOP

**描述**: 启用 IMOP 功能

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="ENABLE_IMOP"/>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2"/>
```

---

#### 4.15.2 DISABLE_IMOP - 禁用IMOP

**描述**: 禁用 IMOP 功能

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="DISABLE_IMOP"/>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2"/>
```

---

#### 4.15.3 GET_IMOP_STATUS - 获取IMOP状态

**描述**: 获取 IMOP 功能状态

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="GET_IMOP_STATUS"/>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2">
  <imop_status>enabled</imop_status>
</response>
```

---

#### 4.15.4 DISPLAY_CHART - 显示图表

**描述**: 在放映机上显示测试图表

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="DISPLAY_CHART">
  <chart_type>color_bars</chart_type>
</command>
```

**参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| chart_type | String | 否 | 图表类型（如 "color_bars", "grid" 等）|

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2"/>
```

---

#### 4.15.5 STOP_DISPLAY_CHART - 停止显示图表

**描述**: 停止显示测试图表

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="STOP_DISPLAY_CHART"/>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2"/>
```

---

#### 4.15.6 LOAD_XSEED_DATA - 加载XSEED数据

**描述**: 加载 XSEED 校准数据

**命令格式**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<command version="2.2" cmd="LOAD_XSEED_DATA">
  <data_path>/calibration/xseed_data.xml</data_path>
</command>
```

**响应**:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<response status="OK" version="2.2"/>
```

---

## 5. 附录

### 5.1 数据格式说明

#### 5.1.1 时间格式

所有时间使用 ISO 8601 格式：

**日期时间**:
```
YYYY-MM-DDTHH:MM:SS±HH:MM
示例: 2025-11-06T14:30:00+08:00
```

**日期**:
```
YYYY-MM-DD
示例: 2025-11-06
```

**时间码**:
```
HH:MM:SS:FF
示例: 01:23:45:12
说明: 小时:分钟:秒:帧
```

#### 5.1.2 UUID格式

所有 UUID 使用 URN 格式：
```
urn:uuid:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
示例: urn:uuid:12345678-1234-1234-1234-123456789012
```

#### 5.1.3 文件大小

所有文件大小和容量以**字节 (Bytes)** 为单位。

换算关系：
- 1 KB = 1,024 Bytes
- 1 MB = 1,048,576 Bytes
- 1 GB = 1,073,741,824 Bytes
- 1 TB = 1,099,511,627,776 Bytes

#### 5.1.4 URL格式

支持的 URL 协议：
- `smb://` - Windows 共享
- `nfs://` - NFS 共享
- `ftp://` - FTP 服务器
- `file://` - 本地文件路径
- `rtmp://` - RTMP 流媒体
- `http://` / `https://` - HTTP/HTTPS

---

### 5.2 支持的命令列表

以下是服务器支持的所有76个命令：
```
ADD_LIVEPLAY_SOURCE         添加直播源
CANCEL_INGEST               取消摄取
CANCEL_SCHEDULE             取消排期
CLEAR_HISTORY               清除历史记录
CLEAR_SHOW                  清除放映列表
DELETE_FILE                 删除文件
DELETE_CONTENT              删除内容
UFO_DELETE_CONTENT          UFO删除内容
DELETE_SHOW                 删除放映列表
DISABLE_SCHEDULER           禁用排期器
ENABLE_SCHEDULER            启用排期器
GET_ASSET_FILE              获取资产文件
GET_ASSET_INFO              获取资产信息
GET_ASSET_SIZE              获取资产大小
GET_LIST_OF_ASSET_STATUS    获取资产状态列表
GET_ASSET_URI               获取资产URI
GET_AUTOMATION_LABELS       获取自动化标签
GET_CERTIFICATES            获取证书
GET_CERTIFICATE_CHAIN       获取证书链
GET_SUPPORTED_COMMANDS      获取支持的命令列表
GET_CONTENT_LOGS            获取内容日志
GET_CPL                     获取CPL
GET_CPL_LIST                获取CPL列表
GET_CURRENT_SCHEDULE        获取当前排期
GET_DATE_TIME               获取日期时间
GET_EVENT_LOGS              获取事件日志
GET_EVENT_LOGS_SMPTE        获取SMPTE事件日志
GET_HOTFIX_LIST             获取热修复列表
GET_INGEST_LIST             获取摄取列表
GET_INGEST_STATUS           获取摄取状态
GET_KDM                     获取KDM
GET_KDM_LIST                获取KDM列表
GET_NEXT_SCHEDULE           获取下一个排期
GET_PACKAGE_LIST            获取包列表
GET_PERFORMANCE_LOGS_SMPTE  获取SMPTE性能日志
GET_PLAYBACK_STATUS         获取播放状态
GET_SCHEDULE                获取排期
GET_SCHEDULER_STATUS        获取排期器状态
GET_SCHEDULES               获取排期列表
GET_SERVER_INFO             获取服务器信息
GET_SHOW                    获取放映列表详情
GET_SHOW_LIST               获取放映列表
GET_STORAGE_INFO            获取存储信息
GET_SYSTEM_FILE             获取系统文件
GET_TIMEZONE                获取时区
HEARTBEAT                   心跳检测
INGEST_FILE                 摄取文件
INGEST_CONTENT              摄取内容
UFO_INGEST_CONTENT          UFO摄取内容
LIST_LIVEPLAY_SOURCE        列出直播源
LOAD_SHOW                   加载放映列表
MOVE_PLAYBACK               移动播放位置
PAUSE_PLAYBACK              暂停播放
PLAY_SHOW                   播放
PUT_SCHEDULE                创建/更新排期
PUT_SHOW                    创建/更新放映列表
PUT_SYSTEM_FILE             上传系统文件
REMOVE_LIVEPLAY_SOURCE      移除直播源
SKIP_BACKWARD               跳到上一个CPL
SKIP_FORWARD                跳到下一个CPL
STOP_PLAYBACK               停止播放
TRIGGER_AUTOMATION          触发自动化
UNPAUSE_PLAYBACK            恢复播放
VALIDATE_CPL                验证CPL
VALIDATE_SHOW               验证放映列表
GET_PROJECTOR_STATUS        获取放映机状态
GET_MULTI_SYNC_MODE         获取多机同步模式
GET_WARRANTY_EXPIRY         获取保修到期日期
ENABLE_IMOP                 启用IMOP
DISABLE_IMOP                禁用IMOP
DISPLAY_CHART               显示图表
STOP_DISPLAY_CHART          停止显示图表
LOAD_XSEED_DATA             加载XSEED数据
GET_IMOP_STATUS             获取IMOP状态
GET_SERVER_IP_LIST          获取服务器IP列表
SET_ENCODING                设置编码
```

---

### 5.3 错误代码

常见错误及处理建议：

| 错误类型 | 描述 | 建议处理 |
|---------|------|---------|
| **连接错误** | 无法连接到服务器 | 检查网络、IP地址、端口配置 |
| **超时错误** | 等待响应超时 | 增加超时时间或检查网络延迟 |
| **协议错误** | 无效的头部或长度 | 检查命令格式是否正确 |
| **无效命令** | 命令不存在或拼写错误 | 使用 GET_SUPPORTED_COMMANDS 确认 |
| **参数错误** | 缺少必填参数或参数格式错误 | 检查参数完整性和格式 |
| **权限错误** | 没有执行该操作的权限 | 检查用户权限配置 |
| **状态错误** | 服务器状态不允许执行 | 检查前置条件（如播放前需先加载）|
| **资源不存在** | 请求的资源不存在 | 确认 UUID 是否正确 |
| **存储空间不足** | 磁盘空间不足 | 清理空间或选择其他存储 |
| **内容损坏** | 文件完整性校验失败 | 重新摄取内容 |

---

## 结语

本文档详细描述了 GDC DSR 服务器网络控制协议的所有命令和使用方法。在实际使用中：

1. **建议首次连接后立即调用 `SET_ENCODING` 设置 UTF-8 编码**
2. **使用 `GET_SUPPORTED_COMMANDS` 检查服务器支持的功能**
3. **重要操作前先验证（如 `VALIDATE_SHOW`）**
4. **定期使用 `HEARTBEAT` 保持连接活跃**
5. **妥善处理错误响应并实施重试机制**

如有疑问或发现文档错误，请联系 GDC 技术支持。

---

**文档版本**: 2.2 (实际版本)  
**最后更新**: 2025年11月  
**版权所有**: © 2025 GDC Technology Limited

---

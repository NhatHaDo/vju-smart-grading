import math
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.colors import HexColor, white
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
D="/usr/share/fonts/truetype/liberation/"
pdfmetrics.registerFont(TTFont("R",D+"LiberationSans-Regular.ttf"))
pdfmetrics.registerFont(TTFont("B",D+"LiberationSans-Bold.ttf"))
pdfmetrics.registerFont(TTFont("I",D+"LiberationSans-Italic.ttf"))
W,H=landscape(A4)
RED=HexColor("#B61D22"); DRED=HexColor("#8A1418"); GOLD=HexColor("#FCC743")
INK=HexColor("#1C1C1E"); GREY=HexColor("#6B6B70"); LIGHT=HexColor("#F4F1EC"); MID=HexColor("#D9D5CE")
c=canvas.Canvas("/home/user/vju-smart-grading/brand/MBV_Brand_Identity.pdf",pagesize=(W,H))
c.setTitle("MBV - Bộ nhận diện thương hiệu (đề xuất)"); c.setAuthor("Concept")
pg=[0]

def star(cx,cy,r,col):
    if col==GOLD or col==white:
        f="star_color.png" if col==GOLD else "star_white.png"
        c.drawImage(f,cx-r,cy-r,2*r,2*r,mask="auto",preserveAspectRatio=True,anchor="c"); return
    c.setFillColor(col); p=c.beginPath()
    for i in range(10):
        a=math.pi/2+i*math.pi/5; rr=r if i%2==0 else r*0.40
        x,y=cx+rr*math.cos(a),cy+rr*math.sin(a)
        p.moveTo(x,y) if i==0 else p.lineTo(x,y)
    p.close(); c.drawPath(p,fill=1,stroke=0)

def logo(x,y,h,mode="full"):
    """logo gốc: x,y = góc dưới trái; h ~ chiều cao chữ. mode: full/red/white/mono"""
    f={"full":"logo_color.png","red":"logo_red.png","white":"logo_white.png","mono":"logo_mono.png","blue":"logo_blue.png"}[mode]
    hh=h*1.55; ww=hh*1055/425
    c.drawImage(f,x,y-h*0.02,ww,hh,mask="auto")
    return ww

def head(n,title,sub=None):
    c.setFillColor(white); c.rect(0,0,W,H,fill=1,stroke=0)
    c.setFillColor(RED); c.rect(0,H-8,W,8,fill=1,stroke=0)
    c.setFillColor(GREY); c.setFont("B",9); c.drawString(40,H-36,"%02d — %s"%(n,title.upper()))
    star(W-52,H-34,7,GOLD)
    c.setFillColor(INK); c.setFont("B",26); c.drawString(40,H-76,title)
    if sub:
        c.setFillColor(GREY); c.setFont("R",11); c.drawString(40,H-96,sub)
    c.setFillColor(GREY); c.setFont("R",8)
    c.drawString(40,22,"MBV · Bộ nhận diện thương hiệu — tổng hợp không chính thức, chưa được MBV xác nhận")
    c.drawRightString(W-40,22,str(n))

def para(x,y,txt,w,fs=10.5,lead=15,font="R",col=INK):
    c.setFont(font,fs); c.setFillColor(col)
    line=""; 
    for wd in txt.split():
        t=(line+" "+wd).strip()
        if pdfmetrics.stringWidth(t,font,fs)>w:
            c.drawString(x,y,line); y-=lead; line=wd
        else: line=t
    if line: c.drawString(x,y,line); y-=lead
    return y

# 1 COVER
c.setFillColor(RED); c.rect(0,0,W,H,fill=1,stroke=0)
c.setFillColor(DRED); p=c.beginPath(); p.moveTo(W*0.62,0); p.lineTo(W,0); p.lineTo(W,H); p.lineTo(W*0.80,H); p.close(); c.drawPath(p,fill=1,stroke=0)
star(W*0.78,H*0.55,150,GOLD)
c.setFillColor(white); c.rect(0,0,W*0.0,0,fill=1)
logo(60,H-140,52,"white")
c.setFillColor(white); c.setFont("B",40); c.drawString(60,H*0.42,"Bộ nhận diện")
c.drawString(60,H*0.42-50,"thương hiệu")
c.setFont("R",14); c.drawString(60,H*0.42-88,"Ngân hàng TNHH MTV Việt Nam Hiện Đại (Modern Bank of Vietnam)")
c.setFillColor(GOLD); c.setFont("B",11); c.drawString(60,60,"BRAND GUIDELINES · PHIÊN BẢN ĐỀ XUẤT 1.0 · 2026")
c.showPage()

# 2 GIỚI THIỆU
head(2,"Về thương hiệu","Bối cảnh & định vị")
y=H-130
y=para(40,y,"MBV là tên gọi mới của OceanBank kể từ 03/2025, sau khi Ngân hàng TNHH MTV Việt Nam Hiện Đại được MB sở hữu 100% vốn điều lệ theo cơ chế chuyển giao bắt buộc. MBV trở thành thành viên trong hệ sinh thái MB Group (MB, MB Campuchia, MBV và các công ty thành viên) và đã đồng loạt thay diện mạo tại 101 điểm giao dịch.",400,11,16)
y-=10
for t,d in [("Sứ mệnh","Đồng hành cùng khách hàng và cộng đồng bằng dịch vụ tài chính hiện đại, an toàn, thiết thực."),
            ("Tầm nhìn","Ngân hàng số thế hệ mới trong hệ sinh thái MB — tiên phong, gần gũi, đáng tin cậy."),
            ("Tính cách","Nhiệt huyết · Tiên phong · Minh bạch · Gần gũi · Hiện đại")]:
    c.setFillColor(RED); c.setFont("B",11); c.drawString(40,y,t.upper()); y-=16
    y=para(40,y,d,400,11,15); y-=8
c.setFillColor(LIGHT); c.roundRect(500,110,300,330,10,fill=1,stroke=0)
c.setFillColor(RED); c.setFont("B",11); c.drawString(524,415,"GIÁ TRỊ CỐT LÕI")
vals=[("Tiên phong","Ngôi sao vàng — khát vọng dẫn đầu"),("Nhiệt huyết","Sắc đỏ — quyết tâm, bứt phá"),("Hiện đại","Hình khối tối giản, số hóa"),("Tin cậy","Nền tảng vững chắc của MB Group")]
yy=385
for a,b in vals:
    star(534,yy+4,7,GOLD); c.setFillColor(INK); c.setFont("B",12); c.drawString(552,yy,a)
    c.setFillColor(GREY); c.setFont("R",9.5); c.drawString(552,yy-14,b); yy-=62
c.setFillColor(GREY); c.setFont("I",8.5); c.drawString(40,50,"Nguồn: thông tin công khai trên báo chí (VietnamBiz, MB, Market Times, 2025).")
c.showPage()

# 3 LOGO
head(3,"Logo","Wordmark MBV đỏ đậm + ngôi sao vàng đan từ các dải song song")
c.setFillColor(LIGHT); c.roundRect(40,150,470,300,10,fill=1,stroke=0)
logo(120,275,80,"full")
c.setStrokeColor(MID); c.setDash(3,3); c.rect(100,255,340,150,fill=0); c.setDash()
c.setFillColor(GREY); c.setFont("R",9); c.drawString(50,160,"Vùng an toàn = chiều cao chữ M · Kích thước tối thiểu: 24 mm (in) / 96 px (số)")
y=H-140
for t,d in [("Ngôi sao vàng đan dải","Năm cánh được đan từ các dải vàng song song — khát vọng tiên phong, đổi mới không ngừng, kết nối. Đặt ở góc trên bên phải chữ."),
            ("Wordmark MBV","Chữ in đậm, nét loe nhẹ, màu đỏ đặc trưng: nhiệt huyết, quyết tâm, cam kết bứt phá."),
            ("Sự liên kết","Bộ ba chữ cái gắn kết với thương hiệu mẹ MB trong cùng hệ sinh thái.")]:
    c.setFillColor(RED); c.setFont("B",11); c.drawString(540,y,t); y-=16
    y=para(540,y,d,260,10,14); y-=12
c.showPage()

# 4 BIẾN THỂ
head(4,"Biến thể logo","Dùng đúng nền, đúng phiên bản")
cells=[("Màu chuẩn · nền trắng",white,"full",True),("Nền đỏ",RED,"white",False),("Nền tối",INK,"white",False),("Một màu đỏ",white,"red",True),("Đơn sắc đen",white,"mono",True),("Nền vàng",GOLD,"mono",False)]
for i,(n,bg,m,bd) in enumerate(cells):
    x=40+(i%3)*255; yb=H-330-(i//3)*185
    c.setFillColor(bg); c.setStrokeColor(MID); c.roundRect(x,yb,240,160,8,fill=1,stroke=1 if bd else 0)
    if m=="full" and bg==GOLD: m="mono"
    logo(x+58,yb+60,26,m)
    c.setFillColor(GREY); c.setFont("R",9); c.drawString(x,yb-14,n)
c.showPage()

# 5 MÀU
head(5,"Bảng màu","Đỏ nhiệt huyết · Vàng tiên phong · Trung tính hiện đại")
cols=[("MBV Red","#B61D22","C15 M100 Y95 K8","Màu chủ đạo",RED,white),("Deep Red","#8A1418","C25 M100 Y100 K45","Nhấn / hover",DRED,white),
      ("Star Gold","#FCC743","C0 M25 Y80 K0","Màu nhấn, ngôi sao",GOLD,INK),("Ink","#1C1C1E","C70 M65 Y60 K85","Chữ chính",INK,white),
      ("Stone","#F4F1EC","C3 M4 Y8 K0","Nền phụ",LIGHT,INK),("White","#FFFFFF","C0 M0 Y0 K0","Nền chính",white,INK)]
ws=[200,110,150,110,80,80]
x=40
for (n,h,cm,u,col,tc),w in zip(cols,ws):
    c.setFillColor(col); c.setStrokeColor(MID); c.rect(x,130,w-4,300,fill=1,stroke=1)
    c.setFillColor(tc); c.setFont("B",12); c.drawString(x+10,405,n)
    c.setFont("R",8.5); c.drawString(x+10,391,h); 
    if w>100: c.drawString(x+10,379,cm); c.drawString(x+10,150,u)
    x+=w+4
c.setFillColor(INK); c.setFont("B",11); c.drawString(40,100,"Tỷ lệ sử dụng"); 
x=40
for w,col in [(0.5,white),(0.25,RED),(0.12,LIGHT),(0.08,INK),(0.05,GOLD)]:
    c.setFillColor(col); c.setStrokeColor(MID); c.rect(x,60,w*760,24,fill=1,stroke=1); x+=w*760
c.setFillColor(GREY); c.setFont("I",8.5); c.drawString(40,46,"Trắng 50% · Đỏ 25% · Stone 12% · Ink 8% · Vàng 5%.  Mã HEX lấy mẫu từ logo; CMYK là quy đổi gần đúng, cần đối chiếu với file gốc của MBV trước khi in.")
c.showPage()

# 6 CHỮ
head(6,"Typography","Rõ ràng, hiện đại, hỗ trợ đầy đủ tiếng Việt")
c.setFillColor(INK); c.setFont("B",64); c.drawString(40,H-190,"Aa Ăâ Êô Ơư")
c.setFont("B",12); c.drawString(40,H-215,"Tiêu đề: Sans-serif đậm (Arial Bold / Liberation Sans Bold — dùng trong tài liệu này)")
c.setFont("R",12); c.drawString(40,H-235,"Nội dung: Sans-serif thường (Arial / Liberation Sans); gợi ý web: Be Vietnam Pro")
sp=[("H1","Ngân hàng số hiện đại",30,"B"),("H2","Giải pháp tài chính cho mọi khách hàng",20,"B"),("Body","Mở tài khoản, chuyển tiền, tiết kiệm và vay vốn nhanh chóng, an toàn ngay trên ứng dụng MBV.",11,"R"),("Caption","Điều kiện & điều khoản áp dụng · Lãi suất cập nhật theo niêm yết",8.5,"R")]
y=H-290
for tag,t,s,f in sp:
    c.setFillColor(RED); c.setFont("B",9); c.drawString(40,y,tag)
    c.setFillColor(INK); c.setFont(f,s); c.drawString(110,y,t); y-=s+28
c.setFillColor(GREY); c.setFont("R",9); c.drawString(40,60,"Quy tắc: tối đa 2 độ đậm · dòng cách 1.4–1.5 · tiêu đề căn trái · không dùng chữ viết hoa toàn bộ cho đoạn văn.")
c.showPage()

# 7 ỨNG DỤNG: danh thiếp, thẻ, app icon
head(7,"Ứng dụng văn phòng","Danh thiếp · Phong bì · Thẻ")
# business card
c.setFillColor(white); c.setStrokeColor(MID); c.roundRect(50,270,270,160,6,fill=1,stroke=1)
logo(70,382,18,"full")
c.setFillColor(INK); c.setFont("B",13); c.drawString(70,340,"Nguyễn Văn An"); c.setFillColor(GREY); c.setFont("R",9); c.drawString(70,326,"Giám đốc Quan hệ Khách hàng")
c.drawString(70,296,"an.nguyen@mbv.com.vn · 1900 xxxx"); c.setFillColor(RED); c.rect(50,270,270,6,fill=1,stroke=0)
c.setFillColor(RED); c.roundRect(340,270,270,160,6,fill=1,stroke=0); star(475,350,50,GOLD)
logo(365,290,16,"white")
# card
c.setFillColor(INK); c.roundRect(50,70,270,170,12,fill=1,stroke=0)
c.setFillColor(RED); p=c.beginPath(); p.moveTo(170,70); p.lineTo(320,70); p.lineTo(320,240); p.lineTo(230,240); p.close(); c.drawPath(p,fill=1,stroke=0)
logo(70,190,16,"white"); c.setFillColor(white); c.setFont("B",13); c.drawString(70,120,"1234  5678  9012  3456"); c.setFont("R",8); c.drawString(70,100,"NGUYEN VAN AN")
star(290,95,11,GOLD)
# app icon
for i,(bg,m) in enumerate([(RED,"white"),(white,"full")]):
    x=370+i*130
    c.setFillColor(bg); c.setStrokeColor(MID); c.roundRect(x,110,110,110,26,fill=1,stroke=1)
    star(x+55,178,26,GOLD if m=="white" else GOLD)
    c.setFillColor(white if m=="white" else RED); c.setFont("B",22); c.drawCentredString(x+55,128,"MBV")
c.setFillColor(GREY); c.setFont("R",9); c.drawString(370,92,"Biểu tượng ứng dụng · nền đỏ / nền trắng")
c.showPage()

# 8 ỨNG DỤNG: chi nhánh + digital
head(8,"Chi nhánh & Digital","Bảng hiệu · Mobile banking · Banner")
c.setFillColor(LIGHT); c.rect(40,290,420,150,fill=1,stroke=0)
c.setFillColor(MID); c.rect(40,290,420,20,fill=1,stroke=0)
c.setFillColor(RED); c.rect(70,340,360,80,fill=1,stroke=0); logo(150,362,24,"white")
c.setFillColor(GREY); c.setFont("R",9); c.drawString(40,270,"Bảng hiệu chi nhánh: nền đỏ, logo trắng – sao vàng")
# phone
c.setFillColor(INK); c.roundRect(500,110,150,330,20,fill=1,stroke=0)
c.setFillColor(white); c.roundRect(506,118,138,314,16,fill=1,stroke=0)
c.setFillColor(RED); c.roundRect(506,340,138,92,16,fill=1,stroke=0); c.rect(506,340,138,20,fill=1,stroke=0)
c.setFillColor(white); c.setFont("R",8); c.drawString(518,410,"Xin chào, An"); c.setFont("B",15); c.drawString(518,385,"250.000.000 ₫")
for i,t in enumerate(["Chuyển tiền","Tiết kiệm","Thanh toán","Vay vốn"]):
    x=516+(i%2)*62; yb=270-(i//2)*66
    c.setFillColor(LIGHT); c.roundRect(x,yb,56,56,8,fill=1,stroke=0); star(x+28,yb+34,10,GOLD)
    c.setFillColor(INK); c.setFont("R",7); c.drawCentredString(x+28,yb+8,t)
# banner
c.setFillColor(RED); c.rect(40,120,420,120,fill=1,stroke=0); star(410,180,60,GOLD)
c.setFillColor(white); c.setFont("B",22); c.drawString(60,190,"Tiết kiệm hiện đại")
c.setFont("R",12); c.drawString(60,168,"Lãi suất hấp dẫn — Mở ngay trên MBV App"); 
c.setFillColor(GOLD); c.roundRect(60,130,110,26,13,fill=1,stroke=0); c.setFillColor(INK); c.setFont("B",10); c.drawCentredString(115,139,"Mở ngay")
c.showPage()

# 9 NÊN / KHÔNG NÊN
head(9,"Quy tắc sử dụng","Giữ logo nhất quán")
bad=[("Không kéo giãn/méo","x"),("Không đổi màu chữ","c"),("Không đặt trên nền nhiễu","n"),("Không xoay/nghiêng","r")]
for i,(t,k) in enumerate(bad):
    x=40+i*195; c.setFillColor(LIGHT); c.roundRect(x,250,180,130,8,fill=1,stroke=0)
    c.saveState(); 
    if k=="x": c.translate(x+14,300); c.scale(1.0,0.5); logo(0,0,14,"full")
    elif k=="c":
        logo(x+20,295,20,"blue")
    elif k=="n":
        c.setFillColor(HexColor("#8fbf6a")); c.rect(x,250,180,130,fill=1,stroke=0); logo(x+20,300,16,"full")
    else: c.translate(x+30,270); c.rotate(20); logo(0,0,16,"full")
    c.restoreState()
    c.setFillColor(RED); c.setFont("B",14); c.drawString(x,232,"✕" if False else "X"); c.setFillColor(INK); c.setFont("R",10); c.drawString(x+18,232,t)
c.setFillColor(INK); c.setFont("B",12); c.drawString(40,180,"Nên")
for i,t in enumerate(["Dùng file vector gốc, giữ đúng tỷ lệ.","Chừa vùng an toàn xung quanh logo.","Dùng bản trắng trên nền đỏ/tối, bản màu trên nền sáng.","Sao vàng chỉ dùng như điểm nhấn, không lặp quá 1–2 lần mỗi trang."]):
    star(46,150-i*22+4,5,GOLD); c.setFillColor(INK); c.setFont("R",10.5); c.drawString(60,150-i*22,t)
c.showPage()

# 10 LIÊN HỆ / GHI CHÚ
c.setFillColor(RED); c.rect(0,0,W,H,fill=1,stroke=0); star(W-140,140,110,GOLD)
logo(60,H-130,44,"white")
c.setFillColor(white); c.setFont("B",22); c.drawString(60,H*0.5,"Ghi chú quan trọng")
para(60,H*0.5-30,"Đây là bản tổng hợp bộ nhận diện MBV dùng file logo do khách hàng cung cấp; mã màu lấy mẫu từ logo, font, tỷ lệ và bố cục ứng dụng là đề xuất; không phải tài liệu chính thức của MBV/MB. Khi sử dụng thực tế, cần đối chiếu và xin tài sản thương hiệu gốc từ MBV.",560,12,18,"R",white)
c.showPage()
c.save()
